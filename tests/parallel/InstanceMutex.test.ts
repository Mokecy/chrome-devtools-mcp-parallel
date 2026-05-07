/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {InstanceMutex} from '../../src/parallel/InstanceMutex.js';

describe('InstanceMutex', () => {
  it('same id serializes', async () => {
    const mutex = new InstanceMutex();
    const order: number[] = [];

    const lock1 = await mutex.acquire('a');
    const p2 = mutex.acquire('a').then(lock => {
      order.push(2);
      lock.dispose();
    });
    order.push(1);
    lock1.dispose();
    await p2;

    assert.deepEqual(order, [1, 2]);
  });

  it('different ids run in parallel', async () => {
    const mutex = new InstanceMutex();
    const order: string[] = [];

    const lockA = await mutex.acquire('a');
    const lockB = await mutex.acquire('b');
    order.push('a-acquired', 'b-acquired');
    lockA.dispose();
    lockB.dispose();

    assert.deepEqual(order, ['a-acquired', 'b-acquired']);
  });

  it('global lock blocks per-id acquires', async () => {
    const mutex = new InstanceMutex();
    const order: number[] = [];

    const globalLock = await mutex.acquire(undefined);
    let perIdResolved = false;
    const perIdPromise = mutex.acquire('x').then(lock => {
      perIdResolved = true;
      order.push(2);
      lock.dispose();
    });

    // Give microtask a chance
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(perIdResolved, false, 'per-id should be blocked by global');

    order.push(1);
    globalLock.dispose();
    await perIdPromise;

    assert.deepEqual(order, [1, 2]);
  });

  it('global lock waits for active per-id locks to drain', async () => {
    const mutex = new InstanceMutex();
    const order: number[] = [];

    const lockA = await mutex.acquire('a');
    let globalResolved = false;
    const globalPromise = mutex.acquire(undefined).then(lock => {
      globalResolved = true;
      order.push(2);
      lock.dispose();
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(globalResolved, false, 'global should wait for per-id drain');

    order.push(1);
    lockA.dispose();
    await globalPromise;

    assert.deepEqual(order, [1, 2]);
  });

  it('global and per-id are mutually exclusive', async () => {
    const mutex = new InstanceMutex();
    const order: string[] = [];

    // Acquire per-id first
    const lockA = await mutex.acquire('a');
    order.push('a-held');

    // Global tries to acquire - blocked
    let globalAcquired = false;
    const globalPromise = mutex.acquire(undefined).then(lock => {
      globalAcquired = true;
      order.push('global-held');
      return lock;
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(globalAcquired, false);

    // Another per-id 'b' tries - should also be blocked once global is waiting?
    // Actually per our semantics: global waits for per-id drain, but new per-id
    // requests should be blocked if global is "waiting" (queued).
    // Let's verify: per-id 'b' should be blocked because globalLocked becomes true
    // after the drain completes.

    // Release 'a' - global should now acquire
    lockA.dispose();
    const globalLock = await globalPromise;
    assert.equal(globalAcquired, true);

    // Now per-id 'b' should be blocked
    let bAcquired = false;
    const bPromise = mutex.acquire('b').then(lock => {
      bAcquired = true;
      order.push('b-held');
      lock.dispose();
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(bAcquired, false);

    globalLock.dispose();
    await bPromise;

    assert.deepEqual(order, ['a-held', 'global-held', 'b-held']);
  });

  it('multiple same-id acquires queue FIFO', async () => {
    const mutex = new InstanceMutex();
    const order: number[] = [];

    const lock1 = await mutex.acquire('x');
    const p2 = mutex.acquire('x').then(lock => {
      order.push(2);
      lock.dispose();
    });
    const p3 = mutex.acquire('x').then(lock => {
      order.push(3);
      lock.dispose();
    });

    order.push(1);
    lock1.dispose();
    await Promise.all([p2, p3]);

    assert.deepEqual(order, [1, 2, 3]);
  });
});
