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
  available: boolean;
  mcpContext: McpContext;
  readonly createdAt: Date;
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
 * Fields align with tasks T011 / T023.
 */
export interface ParallelServerArgs extends ParsedArguments {
  maxInstances: number;
  autoLaunch: boolean;
}
