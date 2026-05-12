/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T062 — MemoryMonitor unit tests.
 */

import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';

import {
  MemoryMonitor,
  type MemorySample,
} from '../../src/parallel/MemoryMonitor.js';

const FAKE_LIMIT = 4096 * 1024 * 1024; // 4 GB

function makeMu(heapUsedBytes: number): NodeJS.MemoryUsage {
  return {
    rss: heapUsedBytes + 100 * 1024 * 1024,
    heapTotal: heapUsedBytes,
    heapUsed: heapUsedBytes,
    external: 0,
    arrayBuffers: 0,
  };
}

describe('MemoryMonitor (T062)', () => {
  let stderrBuf: string[];
  beforeEach(() => {
    stderrBuf = [];
    mock.method(process.stderr, 'write', (chunk: unknown): boolean => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : String(chunk);
      stderrBuf.push(text);
      return true;
    });
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('records every tick into the ring buffer (cap respected)', async () => {
    let pct = 0.1; // start at 10%
    const monitor = new MemoryMonitor({
      intervalMs: 60_000, // never fires from setInterval; we drive ticks manually
      ringCapacity: 3,
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * pct)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    for (let i = 0; i < 5; i++) {
      pct = 0.1 * (i + 1); // 10, 20, 30, 40, 50
      await monitor.tick();
    }
    const samples = monitor.recentSamples();
    assert.equal(samples.length, 3, 'ring should clamp at capacity');
    // Last entry corresponds to 50% utilisation.
    const last = samples[samples.length - 1];
    assert.ok(last && last.heapPct >= 49 && last.heapPct <= 51);
  });

  it('emits exactly one stderr WARN on rising 80% boundary', async () => {
    let pct = 0.5;
    const warnCalls: MemorySample[] = [];
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * pct)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
      onWarn: s => warnCalls.push(s),
    });
    await monitor.tick();
    assert.equal(warnCalls.length, 0, 'no warn under 80%');

    pct = 0.85;
    await monitor.tick();
    assert.equal(warnCalls.length, 1);
    assert.ok(stderrBuf.some(l => l.includes('[MemoryMonitor][WARN]')));

    // Stay in warn band — no second emission.
    pct = 0.86;
    await monitor.tick();
    assert.equal(
      warnCalls.length,
      1,
      'edge-trigger: no re-emit while still warn',
    );
  });

  it('fires onDanger every tick once over 95%', async () => {
    let pct = 0.5;
    const dangerCalls: MemorySample[] = [];
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * pct)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
      onDanger: s => {
        dangerCalls.push(s);
      },
    });
    pct = 0.97;
    await monitor.tick();
    assert.equal(dangerCalls.length, 1);
    await monitor.tick();
    assert.equal(dangerCalls.length, 2, 'danger should re-fire each tick');
    assert.ok(stderrBuf.some(l => l.includes('[MemoryMonitor][DANGER]')));
  });

  it('drops back to ok cleanly without spurious emissions', async () => {
    let pct = 0.85;
    let warns = 0;
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * pct)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
      onWarn: () => {
        warns++;
      },
    });
    await monitor.tick();
    assert.equal(warns, 1);
    pct = 0.5;
    await monitor.tick();
    pct = 0.85;
    await monitor.tick();
    assert.equal(warns, 2, 're-rising into warn fires again');
  });

  it('survives an onDanger handler that throws', async () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.99)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
      onDanger: () => {
        throw new Error('handler boom');
      },
    });
    // Must not propagate.
    await monitor.tick();
    assert.ok(monitor.recentSamples().length === 1);
  });
});
