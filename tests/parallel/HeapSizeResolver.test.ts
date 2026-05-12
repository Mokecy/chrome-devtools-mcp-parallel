/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T061 — HeapSizeResolver precedence + safety clamp.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  applyPhysicalMemorySafety,
  DEFAULT_HEAP_SIZE_MB,
  resolveHeapSize,
} from '../../src/parallel/HeapSizeResolver.js';

describe('resolveHeapSize (T061)', () => {
  it('returns the default when nothing is supplied', () => {
    const res = resolveHeapSize({});
    assert.equal(res.heapSizeMb, DEFAULT_HEAP_SIZE_MB);
    assert.equal(res.source, 'default');
  });

  it('honours CLI > env > default', () => {
    const cli = resolveHeapSize({
      cliHeapSizeMb: 8192,
      env: {CDM_HEAP_SIZE_MB: '2048'},
    });
    assert.equal(cli.heapSizeMb, 8192);
    assert.equal(cli.source, 'cli');

    const env = resolveHeapSize({
      env: {CDM_HEAP_SIZE_MB: '2048'},
    });
    assert.equal(env.heapSizeMb, 2048);
    assert.equal(env.source, 'env');

    const def = resolveHeapSize({});
    assert.equal(def.source, 'default');
  });

  it('treats <=0 / non-numeric / empty CLI values as unset', () => {
    assert.equal(resolveHeapSize({cliHeapSizeMb: 0}).source, 'default');
    assert.equal(resolveHeapSize({cliHeapSizeMb: -1}).source, 'default');
    assert.equal(resolveHeapSize({cliHeapSizeMb: 'abc'}).source, 'default');
    assert.equal(resolveHeapSize({cliHeapSizeMb: ''}).source, 'default');
  });

  it('parses string CLI values produced by yargs', () => {
    const res = resolveHeapSize({cliHeapSizeMb: '6144'});
    assert.equal(res.heapSizeMb, 6144);
    assert.equal(res.source, 'cli');
  });

  it('respects defaultMb override', () => {
    const res = resolveHeapSize({defaultMb: 1024});
    assert.equal(res.heapSizeMb, 1024);
  });
});

describe('applyPhysicalMemorySafety (FR-021)', () => {
  it('passes through small heaps untouched', () => {
    const r = applyPhysicalMemorySafety(2048, 16_384);
    assert.equal(r.heapMb, 2048);
    assert.equal(r.clampedFromMb, null);
  });

  it('clamps when heap exceeds 75% of total memory', () => {
    // 16 GB total, 14 GB requested → safety cap = 12 GB
    const r = applyPhysicalMemorySafety(14_336, 16_384);
    assert.equal(r.heapMb, Math.floor(16_384 * 0.75));
    assert.equal(r.clampedFromMb, 14_336);
  });

  it('honours custom safety fraction', () => {
    const r = applyPhysicalMemorySafety(8_000, 10_000, 0.5);
    assert.equal(r.heapMb, 5_000);
    assert.equal(r.clampedFromMb, 8_000);
  });

  it('does nothing when totalMemMb is 0 (degenerate)', () => {
    const r = applyPhysicalMemorySafety(4096, 0);
    assert.equal(r.heapMb, 4096);
    assert.equal(r.clampedFromMb, null);
  });
});
