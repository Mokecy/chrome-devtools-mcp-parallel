/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * ConnectionWatchdog: keeps the shared CDP browser connection alive AND
 * handles per-instance browser disconnect events (T053 / FR-013..015).
 *
 * Two responsibilities:
 *  (1) Legacy mode — periodic version() poll on the central
 *      `ConnectedBrowser`, with exponential-backoff reconnect on failure.
 *      Runs only when `start()` is called (i.e. after `browser_connect`
 *      succeeds).
 *  (2) Per-instance event-driven recovery — `onDisconnect(instance, err)`:
 *      transitions the FR-012 state machine through reconnecting → ready
 *      (on success) or reconnecting → dead (on circuit break). Hookable
 *      from `browser.on('disconnected', ...)` in `instanceCreate`.
 *
 * No `--respawn` of launch-mode browsers from here; that lives in
 * `instance_recreate` so the operator stays in control of browser
 * lifetimes. The watchdog only proves an existing browser is reachable.
 */

import {logger} from '../logger.js';

import {connectToBrowser} from './BrowserConnector.js';
import type {InstanceRegistry} from './InstanceRegistry.js';
import type {ConnectedBrowser, Instance} from './types.js';

const CHECK_INTERVAL_MS = 3000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_CIRCUIT_BREAK_AFTER = 3;

export interface WatchdogOptions {
  /** How many reconnect attempts per `onDisconnect` cycle before giving up on this cycle. */
  reconnectMaxAttempts?: number;
  /** Initial backoff in ms; doubles each attempt. */
  reconnectBackoffMs?: number;
  /**
   * Total `onDisconnect` cycles allowed before parking the instance in
   * `dead`. Each `onDisconnect` call counts as one cycle even if the cycle
   * succeeds — the cumulative `instance.reconnectAttempts` counter is what
   * we compare against.
   */
  circuitBreakAfter?: number;
  /** Periodic check interval for the legacy CDP path. */
  checkIntervalMs?: number;
}

export class ConnectionWatchdog {
  #timer: ReturnType<typeof setInterval> | null = null;
  #connectedBrowser: ConnectedBrowser | null;
  #registry: InstanceRegistry;
  #stopped = false;

  readonly #maxRetries: number;
  readonly #initialBackoffMs: number;
  readonly #circuitBreakAfter: number;
  readonly #checkIntervalMs: number;

  /** Active reconnect cycles per instance — guards against re-entrant onDisconnect. */
  readonly #inFlight = new Set<string>();
  /** Cumulative onDisconnect cycle count per instance id (for the circuit breaker). */
  readonly #cycleCount = new Map<string, number>();

  constructor(
    connectedBrowser: ConnectedBrowser | null,
    registry: InstanceRegistry,
    options: WatchdogOptions = {},
  ) {
    this.#connectedBrowser = connectedBrowser;
    this.#registry = registry;
    this.#maxRetries = options.reconnectMaxAttempts ?? DEFAULT_MAX_RETRIES;
    this.#initialBackoffMs =
      options.reconnectBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.#circuitBreakAfter =
      options.circuitBreakAfter ?? DEFAULT_CIRCUIT_BREAK_AFTER;
    this.#checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.#check();
    }, this.#checkIntervalMs);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Per-instance disconnect handler. Wire into
   * `browser.on('disconnected', () => watchdog.onDisconnect(instance, err))`
   * from `instanceCreate`. Idempotent under concurrent calls.
   */
  async onDisconnect(instance: Instance, err?: Error | string): Promise<void> {
    if (instance.state === 'dead') {
      // Already terminal; nothing to do.
      return;
    }
    if (this.#inFlight.has(instance.id)) {
      // Another reconnect cycle is already running for this instance.
      logger(
        `ConnectionWatchdog: skipping concurrent onDisconnect for ${instance.id}`,
      );
      return;
    }
    this.#inFlight.add(instance.id);
    try {
      const cycle = (this.#cycleCount.get(instance.id) ?? 0) + 1;
      this.#cycleCount.set(instance.id, cycle);

      this.#registry.setState(instance.id, 'reconnecting', err ?? null);

      // FR-014a — circuit breaker: each completed onDisconnect call counts
      // as one cycle. Once we exceed `circuitBreakAfter`, park the instance
      // permanently. Operators must call `instance_recreate` to re-arm.
      if (cycle > this.#circuitBreakAfter) {
        this.#registry.setState(
          instance.id,
          'dead',
          `Circuit breaker tripped after ${cycle} reconnect cycles`,
        );
        return;
      }

      // FR-014 — only the cdp path can be auto-recovered here. Launch-mode
      // instances need `instance_recreate` (their browser process is gone).
      if (instance.mode !== 'cdp') {
        this.#registry.setState(
          instance.id,
          'dead',
          'Launch-mode browser exited; call `instance_recreate` to rebuild.',
        );
        return;
      }

      const reconnected = await this.#tryReconnectCdp();
      if (reconnected) {
        this.#registry.setState(instance.id, 'ready');
        // Reset cycle count on a clean recovery so future drops get a
        // fresh budget.
        this.#cycleCount.delete(instance.id);
      } else {
        this.#registry.setState(
          instance.id,
          'dead',
          `CDP reconnect failed after ${this.#maxRetries} attempts`,
        );
      }
    } finally {
      this.#inFlight.delete(instance.id);
    }
  }

  /**
   * Test seam: reset internal cycle bookkeeping. Production code should
   * not need this; `instance_recreate` removes + re-adds the instance, at
   * which point the new id (or fresh registration) starts the counter
   * from zero anyway.
   */
  resetCycleCount(instanceId: string): void {
    this.#cycleCount.delete(instanceId);
  }

  async #check(): Promise<void> {
    if (this.#stopped || !this.#connectedBrowser) {
      return;
    }

    try {
      await this.#connectedBrowser.browser.version();
      // Connection is healthy
    } catch {
      // Connection lost — attempt reconnection
      logger(
        'ConnectionWatchdog: browser connection lost, attempting reconnect...',
      );
      this.stop(); // Pause periodic checks during reconnect
      await this.#reconnect();
    }
  }

  async #reconnect(): Promise<void> {
    const reconnected = await this.#tryReconnectCdp();
    if (reconnected) {
      this.start();
      return;
    }
    // All retries exhausted
    logger(
      'ConnectionWatchdog: max retries reached, marking all CDP instances unavailable',
    );
    if (this.#connectedBrowser) {
      this.#connectedBrowser.available = false;
    }
    for (const instance of this.#registry.list()) {
      if (instance.mode === 'cdp' && instance.state === 'ready') {
        this.#registry.setState(
          instance.id,
          'reconnecting',
          'CDP transport lost',
        );
      }
    }
    // Don't restart timer — wait for next explicit browser_connect call
  }

  /**
   * Shared reconnect loop used by both the periodic poll and the
   * per-instance event handler. Returns true on success.
   */
  async #tryReconnectCdp(): Promise<boolean> {
    let backoffMs = this.#initialBackoffMs;
    for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
      logger(
        `ConnectionWatchdog: reconnect attempt ${attempt}/${this.#maxRetries} (backoff ${backoffMs}ms)`,
      );
      await this.#sleep(backoffMs);
      try {
        if (!this.#connectedBrowser) {
          return false;
        }
        const newBrowser = await connectToBrowser(
          this.#connectedBrowser.cdpUrl,
        );
        this.#connectedBrowser.browser = newBrowser;
        this.#connectedBrowser.available = true;
        this.#registry.refreshCdpBrowser(newBrowser);
        logger('ConnectionWatchdog: reconnected successfully');
        return true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger(`ConnectionWatchdog: attempt ${attempt} failed: ${reason}`);
        backoffMs *= 2;
      }
    }
    return false;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
