/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Parallel mode pure TypeScript types.
 * Mirrors specs/001-parallel-instances/data-model.md §1–§5.
 * No `any`/`as`/`!` per AGENTS.md.
 */

import type {ParsedArguments} from '../bin/chrome-devtools-mcp-cli-options.js';
import type {McpContext} from '../McpContext.js';
import type {Browser, BrowserContext, Page} from '../third_party/index.js';
import type {zod} from '../third_party/index.js';
import type {CallToolResult} from '../third_party/index.js';
import type {
  ToolDefinition,
  Request as ToolRequest,
} from '../tools/ToolDefinition.js';

// ---------- §1 InstanceMode ----------
export type InstanceMode = 'cdp' | 'launch';

// ---------- §3 AuthState ----------
export interface AuthCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // UNIX seconds; -1 = session
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | undefined;
}

export interface AuthOriginStorage {
  origin: string;
  items: ReadonlyArray<readonly [string, string]>;
}

export type AuthCapturedFrom = 'browser_connect' | 'instance_export_auth';

export interface AuthState {
  readonly cookies: readonly AuthCookie[];
  readonly origins: readonly AuthOriginStorage[];
  readonly capturedFrom: AuthCapturedFrom;
  readonly capturedAt: Date;
}

// ---------- §4 ConnectedBrowser ----------
export type ConnectedBrowserType = 'chrome' | 'edge' | 'chromium';

export interface ConnectedBrowser {
  browser: Browser;
  cdpUrl: string;
  browserType: ConnectedBrowserType;
  autoLaunchedByUs: boolean;
  available: boolean;
}

// ---------- §2 Instance ----------
/**
 * Instance lifecycle state machine (FR-012). Allowed transitions:
 *   ready        → reconnecting | dead
 *   reconnecting → ready | dead
 *   dead         → (terminal — only `instance_recreate` can replace it)
 */
export type InstanceState = 'ready' | 'reconnecting' | 'dead';

/**
 * Snapshot of how an instance was originally launched, used by the watchdog
 * to respawn the browser process when CDP reconnects fail (FR-014).
 * `null` for cdp-mode instances that attached to an externally managed
 * browser; in that case the watchdog falls back to CDP-only reconnect.
 */
export interface InstanceLaunchConfig {
  readonly executablePath?: string;
  readonly userDataDir?: string;
  readonly args: readonly string[];
  readonly headless: boolean;
  readonly downloadPath: string;
}

export interface InstanceHealthSnapshot {
  readonly id: string;
  readonly mode: InstanceMode;
  readonly state: InstanceState;
  readonly lastError: string | null;
  readonly lastHealthyAt: string; // ISO timestamp
  readonly reconnectAttempts: number;
  readonly spawnedByService: boolean;
  readonly createdAt: string;
}

export interface Instance {
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
  /** Derived from `state === 'ready'` (FR-012). */
  available: boolean;
  mcpContext: McpContext;
  readonly createdAt: Date;

  // Stability hardening (FR-012..018)
  readonly state: InstanceState;
  readonly lastError: string | null;
  readonly lastHealthyAt: Date;
  readonly reconnectAttempts: number;
  readonly spawnedByService: boolean;
  readonly launchConfig: InstanceLaunchConfig | null;

  /**
   * Transition the state machine. Throws on illegal transitions.
   * Increments `reconnectAttempts` when entering `reconnecting`; resets
   * the counter and updates `lastHealthyAt` when entering `ready`.
   */
  setState(next: InstanceState, lastError?: Error | string | null): void;
  snapshotHealth(): InstanceHealthSnapshot;

  close(): Promise<void>;
  markUnavailable(): void;
  markAvailable(): void;
}

// ---------- §5 DerivedTool ----------
export interface DerivedToolDispatchArgs<
  Schema extends zod.ZodRawShape = zod.ZodRawShape,
> {
  instanceId: string;
  upstreamRequest: ToolRequest<Schema>;
}

export interface DerivedTool<Schema extends zod.ZodRawShape = zod.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly upstream: ToolDefinition<Schema>;
  dispatch(args: DerivedToolDispatchArgs<Schema>): Promise<CallToolResult>;
}

// ---------- ParallelServerArgs ----------
/**
 * Extends upstream `ParsedArguments` with parallel-specific knobs.
 * Fields align with tasks T011 / T023 (parallel) + 001-stability-hardening
 * tasks T005 / T019 / T038 / T059 / T070.
 */
export interface ParallelServerArgs extends ParsedArguments {
  maxInstances: number;
  autoLaunch: boolean;

  // Stability hardening — buffer / log management (FR-001..005)
  consoleBufferSize: number;
  networkBufferSize: number;
  recordSizeCapKb: number;

  // Stability hardening — artifacts & response shaping (FR-006..011a)
  artifactDir?: string;
  maxResponseSizeMb: number;
  inlinePayloadMaxMb: number;

  // Stability hardening — instance self-healing (FR-012..018)
  reconnectMaxAttempts: number;
  reconnectBackoffMs: number;
  circuitBreakAfter: number;

  // Stability hardening — heap & crash protection (FR-019..023)
  heapSize: number;
  memWarnPct: number;
  memDangerPct: number;
  memSampleIntervalSec: number;

  // Stability hardening — observability (FR-024b)
  /**
   * Periodic stderr observability log interval in seconds. 0 (default)
   * disables the periodic emission; the on-demand `system_observe` tool
   * stays available regardless.
   */
  systemObserveIntervalSec: number;
}
