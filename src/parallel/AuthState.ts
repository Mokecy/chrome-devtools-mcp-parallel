/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Global AuthState holder (atomic reference replacement).
 * See specs/001-parallel-instances/data-model.md §8.
 *
 * The singleton is frozen upon write — callers may hold a reference
 * and rely on its immutability. A new write replaces the reference atomically.
 */

import type {
  AuthState,
  AuthCookie,
  AuthOriginStorage,
  AuthCapturedFrom,
} from './types.js';

/**
 * Manages the global frozen AuthState singleton.
 * Thread-safe in the sense that JS single-event-loop guarantees atomic reads,
 * and writes are always full-reference replacements.
 */
export class AuthStateHolder {
  #state: AuthState | null = null;

  /**
   * Current AuthState (or null if none captured yet).
   */
  get(): AuthState | null {
    return this.#state;
  }

  /**
   * Replace global AuthState from a browser or instance export.
   * The input arrays are deep-frozen before storage.
   */
  set(
    cookies: readonly AuthCookie[],
    origins: readonly AuthOriginStorage[],
    capturedFrom: AuthCapturedFrom,
  ): AuthState {
    const state: AuthState = Object.freeze({
      cookies: Object.freeze([...cookies]),
      origins: Object.freeze(
        origins.map(o =>
          Object.freeze({
            origin: o.origin,
            items: Object.freeze([...o.items]),
          }),
        ),
      ),
      capturedFrom,
      capturedAt: new Date(),
    });
    this.#state = state;
    return state;
  }

  /**
   * Clear the stored AuthState.
   */
  clear(): void {
    this.#state = null;
  }

  /**
   * Summary string for tool output (cookie count + origin count).
   * Returns null if no state is captured.
   */
  summary(): string | null {
    if (!this.#state) {
      return null;
    }
    return `${this.#state.cookies.length} cookies, ${this.#state.origins.length} origins with localStorage`;
  }
}
