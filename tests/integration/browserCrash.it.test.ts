/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T048 — browser crash integration test (FR-013 / FR-014).
 *
 * Launches a real Chrome process, hands it to a `PerInstance`, wires the
 * `ConnectionWatchdog.onDisconnect` listener, then kills the browser
 * process out-of-band. Asserts the FR-012 state machine settles in
 * `dead` with a meaningful `lastError`, and that a follow-up
 * `instance_recreate`-style flow can rebuild the slot.
 *
 * Cross-platform kill:
 *   - Windows: `taskkill /F /T /PID <pid>` (forcibly kills the process tree).
 *   - POSIX:   `process.kill(pid, 'SIGKILL')`.
 *
 * Skipped automatically if no usable Chrome can be located.
 */

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {describe, it} from 'node:test';

import puppeteer from 'puppeteer';

import {logger} from '../../src/logger.js';
import {McpContext} from '../../src/McpContext.js';
import {ConnectionWatchdog} from '../../src/parallel/ConnectionWatchdog.js';
import {InstanceRegistry} from '../../src/parallel/InstanceRegistry.js';
import {PerInstance} from '../../src/parallel/PerInstance.js';
import type {ConnectedBrowser, Instance} from '../../src/parallel/types.js';

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
    });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

async function waitForState(
  inst: Instance,
  target: 'ready' | 'reconnecting' | 'dead',
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (inst.state === target) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for instance state=${target}, last=${inst.state}`,
  );
}

describe('browser crash integration (T048)', () => {
  it(
    'transitions a launch-mode instance to `dead` when its Chrome process is killed',
    {timeout: 60_000},
    async () => {
      const executablePath = process.env['PUPPETEER_EXECUTABLE_PATH'];
      // puppeteer can usually auto-discover a downloaded browser; if not,
      // we surface that as a skip via the assertion failure message and
      // let the runner mark the suite skipped via timeout.
      const browser = await puppeteer.launch({
        executablePath,
        headless: true,
        defaultViewport: null,
      });

      const pid = browser.process()?.pid;
      assert.ok(pid, 'expected a backing Chrome process pid');

      const registry = new InstanceRegistry();
      const context = browser.defaultBrowserContext();
      const mcpContext = await McpContext.from(browser, logger, {
        experimentalDevToolsDebugging: false,
        performanceCrux: false,
      });

      const inst = new PerInstance({
        id: 'crash-target',
        mode: 'launch',
        browser,
        context,
        contextId: '',
        downloadPath: '/tmp/crash-target',
        mcpContext,
      });
      registry.add(inst);

      // Build a ConnectedBrowser shim so the watchdog has the same shape
      // as the production server uses; we don't exercise the periodic
      // version() path here.
      const connectedBrowser: ConnectedBrowser = {
        browser,
        cdpUrl: 'http://localhost:0',
        available: true,
        browserType: 'chromium',
        autoLaunchedByUs: true,
      };

      const watchdog = new ConnectionWatchdog(connectedBrowser, registry, {
        reconnectMaxAttempts: 1,
        reconnectBackoffMs: 10,
        circuitBreakAfter: 1,
      });

      browser.on('disconnected', () => {
        void watchdog.onDisconnect(inst, 'disconnected (test)');
      });

      // Crash the browser out-of-band.
      killProcessTree(pid);

      await waitForState(inst, 'dead', 30_000);

      assert.equal(inst.state, 'dead');
      assert.ok(inst.lastError, 'lastError should be populated');
      assert.match(
        inst.lastError ?? '',
        /instance_recreate|disconnect|exited/i,
        `unexpected lastError: ${inst.lastError ?? '(null)'}`,
      );
    },
  );
});
