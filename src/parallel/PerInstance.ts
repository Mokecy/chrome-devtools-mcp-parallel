/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-instance context object representing a single parallel browser session.
 * See specs/001-parallel-instances/data-model.md §2.
 *
 * Phase 2 skeleton — auth/badge/snapshot hooks are no-ops until US2/US4.
 */

import fs from 'node:fs/promises';

import type {McpContext} from '../McpContext.js';
import type {Browser, BrowserContext, Page} from '../third_party/index.js';

import type {Instance, InstanceMode} from './types.js';

export interface PerInstanceInit {
  id: string;
  mode: InstanceMode;
  browser: Browser | null;
  context: BrowserContext;
  contextId: string;
  downloadPath: string;
  mcpContext: McpContext;
}

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
  available: boolean;
  mcpContext: McpContext;
  readonly createdAt: Date;

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
    this.available = true;
    this.mcpContext = init.mcpContext;
    this.createdAt = new Date();
  }

  /**
   * Close this instance, releasing its browser resources.
   * - CDP mode: close only the BrowserContext (shared browser stays alive)
   * - Launch mode: close the entire browser process + clean download dir
   */
  async close(): Promise<void> {
    this.available = false;

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
    this.available = false;
  }

  markAvailable(): void {
    this.available = true;
  }
}
