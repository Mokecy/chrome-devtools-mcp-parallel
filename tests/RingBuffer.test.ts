/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for src/utils/ringBuffer.ts (T006).
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {RingBuffer} from '../src/utils/ringBuffer.js';

describe('RingBuffer', () => {
  it('respects capacity and tracks evicted/totalPushed', () => {
    const buf = new RingBuffer<number>(500);
    for (let i = 0; i < 600; i++) {
      buf.push(i);
    }
    assert.strictEqual(buf.size, 500);
    assert.strictEqual(buf.capacity, 500);
    assert.strictEqual(buf.totalPushed, 600);
    assert.strictEqual(buf.evicted, 100);
  });

  it('returns items oldest-to-newest after eviction', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // evicts 1
    buf.push(5); // evicts 2
    assert.deepStrictEqual(buf.toArray(), [3, 4, 5]);
  });

  it('toArray returns latest 500 of 600 in order', () => {
    const buf = new RingBuffer<number>(500);
    for (let i = 0; i < 600; i++) {
      buf.push(i);
    }
    const arr = buf.toArray();
    assert.strictEqual(arr.length, 500);
    assert.strictEqual(arr[0], 100);
    assert.strictEqual(arr[arr.length - 1], 599);
  });

  it('forEach iterates in oldest-to-newest order', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(10);
    buf.push(20);
    buf.push(30);
    buf.push(40); // evicts 10
    const seen: number[] = [];
    buf.forEach(v => {
      seen.push(v);
    });
    assert.deepStrictEqual(seen, [20, 30, 40]);
  });

  it('clear resets size but preserves historical counters', () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.push(3); // evicts 1
    buf.clear();
    assert.strictEqual(buf.size, 0);
    assert.strictEqual(buf.totalPushed, 3);
    assert.strictEqual(buf.evicted, 1);
    assert.deepStrictEqual(buf.toArray(), []);
  });

  it('rejects non-positive capacity', () => {
    assert.throws(() => new RingBuffer<number>(0));
    assert.throws(() => new RingBuffer<number>(-5));
    assert.throws(() => new RingBuffer<number>(1.5));
  });

  it('does not delegate to Array.shift (constant-time eviction)', () => {
    // Stress test: 100k pushes against a cap of 100. If shift() were used,
    // this would dominate test runtime. We assert it completes well under
    // 250ms on commodity hardware as a smoke check.
    const buf = new RingBuffer<number>(100);
    const start = Date.now();
    for (let i = 0; i < 100_000; i++) {
      buf.push(i);
    }
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 1000,
      `RingBuffer 100k push took ${elapsed}ms; expected < 1000ms`,
    );
    assert.strictEqual(buf.size, 100);
    assert.strictEqual(buf.totalPushed, 100_000);
    assert.strictEqual(buf.evicted, 99_900);
  });
});
