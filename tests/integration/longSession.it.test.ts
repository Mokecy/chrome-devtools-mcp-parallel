/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T015 — long-session soak (FR-001..005 / SC-001).
 *
 * The shipped acceptance criterion (SC-001) is "8h continuous run, RSS
 * growth < 200 MB". This test runs a *scaled-down* simulation of that
 * load — equal pressure-per-second, compressed to ~5 minutes — so it can
 * live in the integration suite without dominating CI.
 *
 * Pressure model (matches the SC-001 worst case):
 *   - 5 console messages / sec   (page.evaluate console.log)
 *   - 5 network requests / sec   (page.evaluate fetch to a 404)
 *
 * Buffer caps are deliberately tightened (console=200, network=400) so
 * that eviction kicks in well before the test ends — the soak is about
 * verifying the eviction loop holds, not about hitting the production
 * defaults.
 *
 * Pass criteria:
 *   - test runs to completion (no OOM / disconnect)
 *   - both buffers report `evicted > 0` (FR-002 ring eviction works)
 *   - RSS growth from steady-state baseline < 50 MB
 *     (proportional to the 200 MB / 8 h envelope)
 *
 * Skip / dial-down:
 *   - set `CDM_LONG_SESSION_DURATION_SEC` to override the run length
 *     (default 300s ≈ 5 min)
 */

import assert from 'node:assert/strict';
import {after, before, describe, it} from 'node:test';

import puppeteer, {type Browser} from 'puppeteer';

import {logger} from '../../src/logger.js';
import {McpContext} from '../../src/McpContext.js';

const DEFAULT_DURATION_SEC = 300;
const TICK_INTERVAL_MS = 200; // 5 ticks/sec
const RSS_GROWTH_BUDGET_MB = 50;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('long-session soak (T015)', () => {
  const durationSec = envInt(
    'CDM_LONG_SESSION_DURATION_SEC',
    DEFAULT_DURATION_SEC,
  );
  const totalTimeoutMs = (durationSec + 120) * 1000;

  let browser: Browser | undefined;

  before(async () => {
    browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it(
    `holds buffers + RSS steady across a ${durationSec}s scaled soak`,
    {timeout: totalTimeoutMs},
    async () => {
      assert.ok(browser, 'browser failed to launch');
      const context = await McpContext.from(browser, logger, {
        experimentalDevToolsDebugging: false,
        performanceCrux: false,
        consoleBufferSize: 200,
        networkBufferSize: 400,
        recordSizeCapKb: 256,
      });

      const mcpPage = context.getSelectedMcpPage();
      const pptrPage = context.getSelectedPptrPage();
      // A blank doc is enough — we drive console + fetch by evaluation.
      await pptrPage.setContent(
        '<html><body><h1>soak</h1></body></html>',
      );

      // Steady-state baseline: GC + a brief warm-up before sampling RSS.
      // (Node's `process.memoryUsage().rss` includes V8 + native; the
      // 50 MB budget is intentionally generous to absorb startup churn.)
      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
      }
      const baselineRss = process.memoryUsage().rss;

      const deadline = Date.now() + durationSec * 1000;
      let ticks = 0;
      while (Date.now() < deadline) {
        // 1 tick = 1 console.log + 1 fetch.
        // Both are fire-and-forget inside the page; we await
        // `evaluate` only for back-pressure.
        await pptrPage.evaluate(seq => {
          console.log(`soak-tick-${seq}`);
          // 404 — we just need a network event, not a real response.
          fetch(`/__soak/${seq}`).catch(() => undefined);
        }, ticks);
        ticks++;
        await sleep(TICK_INTERVAL_MS);
      }

      // Drain any in-flight events before asserting buffer meta.
      await sleep(500);

      const consoleMeta = context.getConsoleBufferMeta(mcpPage, false).total;
      const networkMeta = context.getNetworkBufferMeta(mcpPage, false).total;

      assert.ok(
        consoleMeta.evicted > 0,
        `console buffer should have evicted records, got evicted=${consoleMeta.evicted} totalPushed=${consoleMeta.totalPushed}`,
      );
      assert.ok(
        networkMeta.evicted > 0,
        `network buffer should have evicted records, got evicted=${networkMeta.evicted} totalPushed=${networkMeta.totalPushed}`,
      );
      assert.ok(
        consoleMeta.size <= 200,
        `console buffer should respect cap=200, got size=${consoleMeta.size}`,
      );
      assert.ok(
        networkMeta.size <= 400,
        `network buffer should respect cap=400, got size=${networkMeta.size}`,
      );

      if (typeof globalThis.gc === 'function') {
        globalThis.gc();
      }
      const finalRss = process.memoryUsage().rss;
      const growthMb = (finalRss - baselineRss) / (1024 * 1024);
      assert.ok(
        growthMb < RSS_GROWTH_BUDGET_MB,
        `RSS growth ${growthMb.toFixed(1)} MB exceeded ${RSS_GROWTH_BUDGET_MB} MB budget (baseline=${baselineRss}, final=${finalRss}, ticks=${ticks})`,
      );

      context.dispose();
    },
  );
});
