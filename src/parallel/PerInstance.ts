/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-instance context object representing a single parallel browser session.
 * See specs/001-parallel-instances/data-model.md §2.
 *
 * Phase 2 skeleton — auth/badge/snapshot hooks are no-ops until US2/US4.
 * Stability hardening (001-stability-hardening WP-3): adds an explicit
 * lifecycle state machine + launch-config snapshot for the watchdog.
 */

import fs from 'node:fs/promises';

import type {McpContext} from '../McpContext.js';
import type {Browser, BrowserContext, Page} from '../third_party/index.js';

import type {
  Instance,
  InstanceHealthSnapshot,
  InstanceLaunchConfig,
  InstanceMode,
  InstanceState,
} from './types.js';

export interface PerInstanceInit {
  id: string;
  mode: InstanceMode;
  browser: Browser | null;
  context: BrowserContext;
  contextId: string;
  downloadPath: string;
  mcpContext: McpContext;
  /** Whether this service spawned the browser (vs attached to an external one). */
  spawnedByService?: boolean;
  /**
   * Snapshot of the launch arguments. Required when `spawnedByService` is
   * true so the watchdog can respawn the browser; ignored otherwise.
   */
  launchConfig?: InstanceLaunchConfig | null;
}

const VALID_TRANSITIONS: Record<InstanceState, readonly InstanceState[]> = {
  ready: ['reconnecting', 'dead'],
  reconnecting: ['ready', 'dead'],
  dead: [],
};

export class PerInstance implements Instance {
  readonly id: string;
  readonly mode: InstanceMode;
  browser: Browser | null;
  context: BrowserContext;
  contextId: string;
  selectedPageIdx: number;
  readonly downloadPath: string;
  readonly badgeInjected: WeakSet<Page>;
  prevSnapshot: string | null;
  prevSnapshotOrigin: string | null;
  mcpContext: McpContext;
  readonly createdAt: Date;
  readonly spawnedByService: boolean;
  readonly launchConfig: InstanceLaunchConfig | null;

  #state: InstanceState;
  #lastError: string | null;
  #lastHealthyAt: Date;
  #reconnectAttempts: number;

  constructor(init: PerInstanceInit) {
    this.id = init.id;
    this.mode = init.mode;
    this.browser = init.browser;
    this.context = init.context;
    this.contextId = init.contextId;
    this.selectedPageIdx = 0;
    this.downloadPath = init.downloadPath;
    this.badgeInjected = new WeakSet();
    this.prevSnapshot = null;
    this.prevSnapshotOrigin = null;
    this.mcpContext = init.mcpContext;
    this.createdAt = new Date();
    this.spawnedByService = init.spawnedByService ?? false;
    this.launchConfig = init.launchConfig ?? null;

    this.#state = 'ready';
    this.#lastError = null;
    this.#lastHealthyAt = this.createdAt;
    this.#reconnectAttempts = 0;
  }

  // ---------- state machine (FR-012) ----------
  get state(): InstanceState {
    return this.#state;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get lastHealthyAt(): Date {
    return this.#lastHealthyAt;
  }

  get reconnectAttempts(): number {
    return this.#reconnectAttempts;
  }

  /** Backward-compatible derived flag (`true` iff state === 'ready'). */
  get available(): boolean {
    return this.#state === 'ready';
  }
  set available(value: boolean) {
    // Legacy setter mapped onto the state machine. `false` parks the
    // instance in `reconnecting` (the watchdog will drive it forward); a
    // hard kill goes through `setState('dead', err)` directly. `true`
    // only resurrects a reconnecting instance — `dead` is terminal.
    if (value) {
      if (this.#state === 'reconnecting') {
        this.setState('ready');
      }
    } else if (this.#state === 'ready') {
      this.setState('reconnecting');
    }
  }

  setState(next: InstanceState, lastError?: Error | string | null): void {
    if (next === this.#state) {
      // Idempotent transitions just refresh lastError/lastHealthyAt where
      // meaningful so callers don't have to special-case.
      if (lastError !== undefined) {
        this.#lastError = normaliseError(lastError);
      }
      return;
    }
    const allowed = VALID_TRANSITIONS[this.#state];
    if (!allowed.includes(next)) {
      throw new Error(
        `Illegal instance state transition for ${this.id}: ${this.#state} → ${next}`,
      );
    }

    this.#state = next;
    if (lastError !== undefined) {
      this.#lastError = normaliseError(lastError);
    }

    if (next === 'reconnecting') {
      this.#reconnectAttempts += 1;
    } else if (next === 'ready') {
      this.#reconnectAttempts = 0;
      this.#lastHealthyAt = new Date();
      // Successful reconnect clears any prior error.
      if (lastError === undefined) {
        this.#lastError = null;
      }
    }
  }

  snapshotHealth(): InstanceHealthSnapshot {
    return {
      id: this.id,
      mode: this.mode,
      state: this.#state,
      lastError: this.#lastError,
      lastHealthyAt: this.#lastHealthyAt.toISOString(),
      reconnectAttempts: this.#reconnectAttempts,
      spawnedByService: this.spawnedByService,
      createdAt: this.createdAt.toISOString(),
    };
  }

  /**
   * Close this instance, releasing its browser resources.
   * - CDP mode: close only the BrowserContext (shared browser stays alive)
   * - Launch mode: close the entire browser process + clean download dir
   */
  async close(): Promise<void> {
    if (this.#state !== 'dead') {
      // Force-transition without going through valid-transition checks so
      // close() works from any state including reconnecting.
      this.#state = 'dead';
    }

    if (this.mode === 'cdp') {
      await this.context.close();
    } else {
      // Launch mode: close the whole browser process
      if (this.browser) {
        await this.browser.close();
      }
    }

    // Best-effort cleanup of download directory
    try {
      await fs.rm(this.downloadPath, {recursive: true, force: true});
    } catch {
      // Ignore cleanup failures
    }
  }

  markUnavailable(): void {
    // Legacy "connection broke" hint — park in reconnecting so the
    // watchdog still has a chance to drive recovery. Hard kills go
    // through `setState('dead', err)` directly.
    if (this.#state === 'ready') {
      this.setState('reconnecting');
    }
  }

  markAvailable(): void {
    if (this.#state === 'reconnecting') {
      this.setState('ready');
    }
  }
}

function normaliseError(err: Error | string | null): string | null {
  if (err === null) {
    return null;
  }
  if (typeof err === 'string') {
    return err;
  }
  return err.message || err.name || 'unknown error';
}
