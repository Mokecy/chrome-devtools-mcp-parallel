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

import type {Instance} from './types.js';

export class InstanceRegistry {
  readonly #instances = new Map<string, Instance>();
  readonly #maxInstances: number;

  constructor(maxInstances = 10) {
    this.#maxInstances = maxInstances;
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
}
