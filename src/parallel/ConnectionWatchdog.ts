/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * ConnectionWatchdog: periodically checks browser connectivity and
 * attempts reconnection with exponential backoff.
 * See specs/001-parallel-instances/tasks.md T035.
 */

import {logger} from '../logger.js';

import {connectToBrowser} from './BrowserConnector.js';
import type {InstanceRegistry} from './InstanceRegistry.js';
import type {ConnectedBrowser} from './types.js';

const CHECK_INTERVAL_MS = 3000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export class ConnectionWatchdog {
  #timer: ReturnType<typeof setInterval> | null = null;
  #connectedBrowser: ConnectedBrowser;
  #registry: InstanceRegistry;
  #stopped = false;

  constructor(connectedBrowser: ConnectedBrowser, registry: InstanceRegistry) {
    this.#connectedBrowser = connectedBrowser;
    this.#registry = registry;
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.#check();
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async #check(): Promise<void> {
    if (this.#stopped) {
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
    let backoffMs = INITIAL_BACKOFF_MS;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      logger(
        `ConnectionWatchdog: reconnect attempt ${attempt}/${MAX_RETRIES} (backoff ${backoffMs}ms)`,
      );
      await this.#sleep(backoffMs);

      try {
        const newBrowser = await connectToBrowser(
          this.#connectedBrowser.cdpUrl,
        );
        // Success — update references
        this.#connectedBrowser.browser = newBrowser;
        this.#connectedBrowser.available = true;
        this.#registry.refreshCdpBrowser(newBrowser);
        logger('ConnectionWatchdog: reconnected successfully');
        this.start(); // Resume periodic checks
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger(`ConnectionWatchdog: attempt ${attempt} failed: ${reason}`);
        backoffMs *= 2;
      }
    }

    // All retries exhausted
    logger(
      'ConnectionWatchdog: max retries reached, marking all CDP instances unavailable',
    );
    this.#connectedBrowser.available = false;
    for (const instance of this.#registry.list()) {
      if (instance.mode === 'cdp') {
        instance.markUnavailable();
      }
    }
    // Don't restart timer — wait for next explicit browser_connect call
  }

  #sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
