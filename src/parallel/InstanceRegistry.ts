/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-memory registry for parallel browser instances.
 * See specs/001-parallel-instances/data-model.md §2.
 *
 * All methods are synchronous. Caller MUST hold InstanceMutex global lock
 * for mutating operations (add/remove/refreshCdpBrowser).
 */

import type {Browser} from '../third_party/index.js';

import type {Instance, InstanceHealthSnapshot, InstanceState} from './types.js';

/**
 * Callback fired *after* an instance has transitioned to a new state.
 * Listeners must NEVER throw — exceptions are swallowed by the registry to
 * keep core lifecycle stable. They MUST be cheap; the watchdog calls
 * `setState` from hot paths (every disconnect, every reconnect attempt).
 */
export type StateChangeListener = (
  instance: Instance,
  prev: InstanceState,
  next: InstanceState,
) => void;

export class InstanceRegistry {
  readonly #instances = new Map<string, Instance>();
  readonly #maxInstances: number;
  readonly #listeners = new Set<StateChangeListener>();

  constructor(maxInstances = 10) {
    this.#maxInstances = maxInstances;
  }

  /**
   * Register a listener that fires *after* every successful state change.
   * Returns a disposer for symmetric teardown.
   */
  addStateChangeListener(listener: StateChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get maxInstances(): number {
    return this.#maxInstances;
  }

  size(): number {
    return this.#instances.size;
  }

  /**
   * Register a new instance. Throws if id already exists or limit exceeded.
   */
  add(instance: Instance): void {
    if (this.#instances.has(instance.id)) {
      throw new Error(`Instance "${instance.id}" already exists.`);
    }
    if (this.#instances.size >= this.#maxInstances) {
      throw new Error(
        `Maximum instance limit (${this.#maxInstances}) reached. ` +
          `Close an existing instance before creating a new one.`,
      );
    }
    this.#instances.set(instance.id, instance);
  }

  /**
   * Look up instance by id. Returns undefined if not found.
   */
  get(id: string): Instance | undefined {
    return this.#instances.get(id);
  }

  /**
   * Return all registered instances (snapshot array).
   */
  list(): readonly Instance[] {
    return [...this.#instances.values()];
  }

  /**
   * Remove instance from registry. Returns true if it existed, false otherwise.
   */
  remove(id: string): boolean {
    return this.#instances.delete(id);
  }

  /**
   * After CDP watchdog reconnects, update the browser reference for all
   * cdp-mode instances.
   */
  refreshCdpBrowser(newBrowser: Browser): void {
    for (const instance of this.#instances.values()) {
      if (instance.mode === 'cdp') {
        instance.browser = newBrowser;
        instance.available = true;
      }
    }
  }

  /**
   * Stability hardening (FR-013): drive an instance through its lifecycle
   * state machine via the registry so callers don't need a direct handle.
   * Throws if the instance id is unknown.
   */
  setState(
    id: string,
    state: InstanceState,
    lastError?: Error | string | null,
  ): void {
    const instance = this.#instances.get(id);
    if (!instance) {
      throw new Error(`Instance "${id}" not found in registry.`);
    }
    const prev = instance.state;
    instance.setState(state, lastError);
    const next = instance.state;
    if (prev !== next && this.#listeners.size > 0) {
      for (const listener of this.#listeners) {
        try {
          listener(instance, prev, next);
        } catch {
          // Listener errors must never break the lifecycle; observers are
          // best-effort. Intentionally swallow here — observability code
          // should self-log inside the listener if it cares.
        }
      }
    }
  }

  /**
   * Health snapshot for `instance_health` tool / Observability / CrashLogger
   * (FR-016 / FR-024a). Returns one entry per registered instance, in
   * insertion order.
   */
  snapshotHealth(): readonly InstanceHealthSnapshot[] {
    const snapshots: InstanceHealthSnapshot[] = [];
    for (const instance of this.#instances.values()) {
      snapshots.push(instance.snapshotHealth());
    }
    return snapshots;
  }
}
