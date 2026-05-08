/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Parallel multi-instance MCP server entrypoint.
 * See specs/001-parallel-instances/plan.md for design rationale.
 * Implements T022: register management tools + derive page_* tools.
 */

import {buildFlag} from '../index.js';
import {
  McpServer,
  zod,
  SetLevelRequestSchema,
  StdioServerTransport,
} from '../third_party/index.js';
import type {CallToolResult} from '../third_party/index.js';
import {OFF_BY_DEFAULT_CATEGORIES} from '../tools/categories.js';
import type {ToolDefinition} from '../tools/ToolDefinition.js';
import type {DefinedPageTool} from '../tools/ToolDefinition.js';
import {createTools} from '../tools/tools.js';
import {VERSION} from '../version.js';

import {AuthStateHolder} from './AuthState.js';
import {ConnectionWatchdog} from './ConnectionWatchdog.js';
import {InstanceMutex} from './InstanceMutex.js';
import {InstanceRegistry} from './InstanceRegistry.js';
import {browserConnectTool} from './managementTools/browserConnect.js';
import {instanceClose} from './managementTools/instanceClose.js';
import {instanceCloseAll} from './managementTools/instanceCloseAll.js';
import {instanceCreate} from './managementTools/instanceCreate.js';
import {instanceExportAuth} from './managementTools/instanceExportAuth.js';
import {instanceList} from './managementTools/instanceList.js';
import {derivePageTool} from './PageToolAdapter.js';
import type {ParallelServerArgs, ConnectedBrowser} from './types.js';

export interface ParallelMcpServerHandle {
  shutdown(): Promise<void>;
}

/**
 * Check if a tool is disabled per CLI flags.
 * Replicates logic from src/index.ts getToolStatusInfo since it's not exported.
 */
function isToolDisabled(
  tool: ToolDefinition | DefinedPageTool,
  serverArgs: ParallelServerArgs,
): boolean {
  const category = tool.annotations.category;
  if (category) {
    const categoryFlag = buildFlag(category);
    const flagValue = serverArgs[categoryFlag];
    const isOff = OFF_BY_DEFAULT_CATEGORIES.includes(category)
      ? !flagValue
      : flagValue === false;
    if (isOff) {
      return true;
    }
  }

  for (const condition of tool.annotations.conditions || []) {
    if (condition && !serverArgs[condition]) {
      return true;
    }
  }

  return false;
}

/**
 * Construct the parallel-mode MCP server.
 */
export async function createParallelMcpServer(
  args: ParallelServerArgs,
): Promise<ParallelMcpServerHandle> {
  const registry = new InstanceRegistry(args.maxInstances);
  const mutex = new InstanceMutex();
  const authStateHolder = new AuthStateHolder();
  let connectedBrowser: ConnectedBrowser | null = null;
  let watchdog: ConnectionWatchdog | null = null;

  const server = new McpServer(
    {
      name: 'chrome_devtools_parallel',
      title: 'Chrome DevTools MCP Parallel Server',
      version: VERSION,
    },
    {capabilities: {logging: {}}},
  );
  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  // --- Management Tools ---

  // instance_create
  server.registerTool(
    'instance_create',
    {
      description:
        'Create a new isolated browser instance. Supports cloning the current global AuthState to skip re-login.',
      inputSchema: {
        instanceId: zod
          .string()
          .min(1)
          .describe('Unique identifier for this instance.'),
        url: zod
          .string()
          .optional()
          .describe('Optional initial URL to navigate to.'),
        cloneAuth: zod
          .boolean()
          .optional()
          .describe('Clone global AuthState into new instance. Default true.'),
        useCDP: zod
          .boolean()
          .optional()
          .describe(
            'Use CDP mode (connected browser). Falls back to launch if unavailable.',
          ),
        permissions: zod
          .record(zod.string(), zod.array(zod.string()))
          .optional()
          .describe(
            'Map of origin -> array of W3C permission names to grant (e.g. {"https://map.baidu.com": ["geolocation"]}). Pass empty array to deny all. Names must come from puppeteer Permission type; native Chrome UI prompts (device discovery, hid) cannot be suppressed via this option — use --chrome-arg flags instead.',
          ),
      },
      annotations: {
        title: 'Create Instance',
        readOnlyHint: false,
      },
    },
    async (params: {
      instanceId: string;
      url?: string;
      cloneAuth?: boolean;
      useCDP?: boolean;
      permissions?: Record<string, string[]>;
    }): Promise<CallToolResult> => {
      const release = await mutex.acquire(undefined);
      try {
        return await instanceCreate(
          {
            instanceId: params.instanceId,
            url: params.url,
            cloneAuth: params.cloneAuth,
            useCDP: params.useCDP,
            permissions: params.permissions,
          },
          {registry, serverArgs: args, connectedBrowser, authStateHolder},
        );
      } finally {
        release.dispose();
      }
    },
  );

  // instance_list
  server.registerTool(
    'instance_list',
    {
      description:
        'List all live instances with their current main page URL and title.',
      inputSchema: {},
      annotations: {
        title: 'List Instances',
        readOnlyHint: true,
      },
    },
    async (): Promise<CallToolResult> => {
      const release = await mutex.acquire(undefined);
      try {
        return await instanceList(registry);
      } finally {
        release.dispose();
      }
    },
  );

  // instance_close
  server.registerTool(
    'instance_close',
    {
      description: 'Close a single instance and release its resources.',
      inputSchema: {
        instanceId: zod.string().min(1).describe('Instance to close.'),
      },
      annotations: {
        title: 'Close Instance',
        readOnlyHint: false,
      },
    },
    async (params): Promise<CallToolResult> => {
      const release = await mutex.acquire(undefined);
      try {
        return await instanceClose({instanceId: params.instanceId}, registry);
      } finally {
        release.dispose();
      }
    },
  );

  // instance_close_all
  server.registerTool(
    'instance_close_all',
    {
      description: 'Close all instances at once.',
      inputSchema: {},
      annotations: {
        title: 'Close All Instances',
        readOnlyHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      const release = await mutex.acquire(undefined);
      try {
        return await instanceCloseAll(registry);
      } finally {
        release.dispose();
      }
    },
  );

  // browser_connect
  server.registerTool(
    'browser_connect',
    {
      description:
        'Connect to a Chrome/Edge instance with remote debugging enabled and extract its auth state.',
      inputSchema: {
        cdpUrl: zod
          .string()
          .optional()
          .describe('Optional explicit CDP endpoint.'),
        pageIndex: zod
          .number()
          .optional()
          .describe('Page index for auth extraction. Default 0.'),
        autoLaunch: zod
          .boolean()
          .optional()
          .describe('Whether to auto-launch Chrome if no port detected.'),
      },
      annotations: {
        title: 'Connect Browser',
        readOnlyHint: false,
      },
    },
    async (params: {
      cdpUrl?: string;
      pageIndex?: number;
      autoLaunch?: boolean;
    }): Promise<CallToolResult> => {
      const release = await mutex.acquire(undefined);
      try {
        const result = await browserConnectTool(
          {
            cdpUrl: params.cdpUrl,
            pageIndex: params.pageIndex,
            autoLaunch: params.autoLaunch,
          },
          {
            authStateHolder,
            setConnectedBrowser: (cb: ConnectedBrowser) => {
              // Stop previous watchdog if any
              if (watchdog) {
                watchdog.stop();
              }
              connectedBrowser = cb;
              // Start new watchdog
              watchdog = new ConnectionWatchdog(cb, registry);
              watchdog.start();
            },
            defaultAutoLaunch: args.autoLaunch,
          },
        );
        return result;
      } finally {
        release.dispose();
      }
    },
  );

  // instance_export_auth
  server.registerTool(
    'instance_export_auth',
    {
      description:
        'Export cookies and localStorage from the specified instance or connected browser as global AuthState.',
      inputSchema: {
        instanceId: zod
          .string()
          .optional()
          .describe('Instance to export from. Omit to use connected browser.'),
      },
      annotations: {
        title: 'Export Auth',
        readOnlyHint: true,
      },
    },
    async (params: {instanceId?: string}): Promise<CallToolResult> => {
      const release = await mutex.acquire(undefined);
      try {
        return await instanceExportAuth(
          {instanceId: params.instanceId},
          {registry, authStateHolder, connectedBrowser},
        );
      } finally {
        release.dispose();
      }
    },
  );

  // --- Derive page_* tools from upstream ---
  const upstreamTools = createTools(args);
  for (const tool of upstreamTools) {
    // Skip disabled tools (FR-008)
    if (isToolDisabled(tool, args)) {
      continue;
    }

    const derived = derivePageTool(tool, {registry, mutex, serverArgs: args});

    server.registerTool(
      derived.name,
      {
        description: derived.description,
        inputSchema: derived.schema,
        annotations: {
          title: derived.annotations.title,
          readOnlyHint: derived.annotations.readOnlyHint,
        },
      },
      async (params: Record<string, unknown>): Promise<CallToolResult> => {
        return derived.dispatch(params);
      },
    );
  }

  // --- Start stdio transport ---
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    async shutdown() {
      await instanceCloseAll(registry);
      await server.close();
    },
  };
}

export type {ParallelServerArgs} from './types.js';
