/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-instance mutex with read-write semantics.
 * See specs/001-parallel-instances/data-model.md §6.
 *
 * - global lock = "write" (exclusive): blocks all per-id and global acquires
 * - per-id lock = "read" per specific id: same-id serial, cross-id parallel
 * - global lock waits for all per-id locks to release before acquiring
 * - per-id lock waits for global lock to release before acquiring
 */

export interface Release {
  dispose(): void;
}

interface Deferred {
  resolve: () => void;
  promise: Promise<void>;
}

function createDeferred(): Deferred {
  const deferred: Deferred = {
    resolve: () => {
      /* placeholder until overwritten */
    },
    promise: Promise.resolve(),
  };
  deferred.promise = new Promise<void>(r => {
    deferred.resolve = r;
  });
  return deferred;
}

export class InstanceMutex {
  /** Per-id queues: same id serializes, different ids run in parallel */
  readonly #perIdQueues = new Map<string, Array<() => void>>();
  readonly #perIdLocked = new Map<string, boolean>();

  /** Global (management tool) exclusive lock */
  #globalLocked = false;
  readonly #globalQueue: Array<() => void> = [];

  /** Count of currently held per-id locks (across all ids) */
  #activePerIdCount = 0;

  /** Waiters for activePerIdCount to reach 0 (global lock acquisition) */
  readonly #waitForPerIdDrain: Array<() => void> = [];

  /** Per-id waiters waiting for global lock to release */
  readonly #perIdGlobalWaiters: Array<() => void> = [];

  /**
   * Acquire a lock.
   * - `instanceId` provided → per-id lock (same id serial, cross-id parallel)
   * - `instanceId` undefined → global exclusive lock
   */
  async acquire(instanceId?: string): Promise<Release> {
    if (instanceId === undefined) {
      return this.#acquireGlobal();
    }
    return this.#acquirePerInstance(instanceId);
  }

  async #acquireGlobal(): Promise<Release> {
    // Wait until no global lock held
    if (this.#globalLocked) {
      const deferred = createDeferred();
      this.#globalQueue.push(deferred.resolve);
      await deferred.promise;
    }
    this.#globalLocked = true;

    // Wait until all per-id locks drain
    if (this.#activePerIdCount > 0) {
      const deferred = createDeferred();
      this.#waitForPerIdDrain.push(deferred.resolve);
      await deferred.promise;
    }

    return {dispose: () => this.#releaseGlobal()};
  }

  #releaseGlobal(): void {
    this.#globalLocked = false;
    // Wake next global waiter if any
    const next = this.#globalQueue.shift();
    if (next) {
      next();
      return;
    }
    // Wake all pending per-id waiters blocked on globalLocked
    this.#wakePerIdGlobalWaiters();
  }

  #wakePerIdGlobalWaiters(): void {
    const waiters = this.#perIdGlobalWaiters.splice(0);
    for (const w of waiters) {
      w();
    }
  }

  async #acquirePerInstance(instanceId: string): Promise<Release> {
    // Wait if global lock is held
    if (this.#globalLocked) {
      const deferred = createDeferred();
      this.#perIdGlobalWaiters.push(deferred.resolve);
      await deferred.promise;
      // After waking, check again (global might have been re-acquired)
      if (this.#globalLocked) {
        return this.#acquirePerInstance(instanceId);
      }
    }

    // Now acquire per-id lock (FIFO within same id)
    const locked = this.#perIdLocked.get(instanceId) ?? false;
    if (!locked) {
      this.#perIdLocked.set(instanceId, true);
      this.#activePerIdCount++;
      return {dispose: () => this.#releasePerInstance(instanceId)};
    }

    // Queue up
    let queue = this.#perIdQueues.get(instanceId);
    if (!queue) {
      queue = [];
      this.#perIdQueues.set(instanceId, queue);
    }
    const deferred = createDeferred();
    queue.push(deferred.resolve);
    await deferred.promise;

    // When woken, we now hold the lock
    return {dispose: () => this.#releasePerInstance(instanceId)};
  }

  #releasePerInstance(instanceId: string): void {
    const queue = this.#perIdQueues.get(instanceId);
    const next = queue?.shift();
    if (next) {
      // Hand off to next waiter for same id
      next();
      return;
    }

    // No more waiters for this id
    this.#perIdLocked.set(instanceId, false);
    if (queue && queue.length === 0) {
      this.#perIdQueues.delete(instanceId);
    }
    this.#activePerIdCount--;

    // If activePerIdCount hits 0, wake global waiters
    if (this.#activePerIdCount === 0) {
      const drainWaiters = this.#waitForPerIdDrain.splice(0);
      for (const w of drainWaiters) {
        w();
      }
    }
  }
}
