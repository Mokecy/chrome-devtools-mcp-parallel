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
import {getArtifactDirManager} from '../utils/artifactDir.js';
import {VERSION} from '../version.js';

import {AuthStateHolder} from './AuthState.js';
import {ConnectionWatchdog} from './ConnectionWatchdog.js';
import {CrashLogger} from './CrashLogger.js';
import {InstanceMutex} from './InstanceMutex.js';
import {InstanceRegistry} from './InstanceRegistry.js';
import {artifactReadSummary} from './managementTools/artifactReadSummary.js';
import {browserConnectTool} from './managementTools/browserConnect.js';
import {instanceClose} from './managementTools/instanceClose.js';
import {instanceCloseAll} from './managementTools/instanceCloseAll.js';
import {instanceCreate} from './managementTools/instanceCreate.js';
import {instanceExportAuth} from './managementTools/instanceExportAuth.js';
import {instanceHealth} from './managementTools/instanceHealth.js';
import {instanceList} from './managementTools/instanceList.js';
import {instanceRecreate} from './managementTools/instanceRecreate.js';
import {systemObserve} from './managementTools/systemObserve.js';
import {MemoryMonitor} from './MemoryMonitor.js';
import {Notifier} from './Notifier.js';
import {Observability} from './Observability.js';
import {derivePageTool} from './PageToolAdapter.js';
import {ToolCallRing} from './ToolCallRing.js';
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
  // T031: eagerly create the ArtifactDirManager singleton so the SIGINT /
  // SIGTERM cleanup hooks are registered before any tool ever runs. Lazy
  // construction during the first oversize response would race shutdown.
  getArtifactDirManager({persistentRoot: args.artifactDir});

  // T033: bridge `--inline-payload-max-mb` to the env var that
  // `src/tools/screenshot.ts` reads. Tools instantiated via the upstream
  // factory don't see `ParallelServerArgs`, so the env hop keeps both worlds
  // consistent without expanding the upstream `ParsedArguments` shape.
  if (typeof args.inlinePayloadMaxMb === 'number') {
    process.env['CDM_INLINE_PAYLOAD_MAX_MB'] = String(args.inlinePayloadMaxMb);
  }
  let connectedBrowser: ConnectedBrowser | null = null;
  // Create watchdog eagerly so launch-mode instances can wire
  // browser.on('disconnected') immediately. The CDP polling path
  // (`start()`) is still only activated after `browser_connect`.
  let watchdog: ConnectionWatchdog = new ConnectionWatchdog(null, registry, {
    reconnectMaxAttempts: args.reconnectMaxAttempts,
    reconnectBackoffMs: args.reconnectBackoffMs,
    circuitBreakAfter: args.circuitBreakAfter,
  });

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

  // T054 — push state-change notifications onto the logging channel so
  // clients can react to crashes / reconnects without polling.
  const notifier = new Notifier(server, registry);
  notifier.attach();

  // T067 — capped ring of recent tool dispatches for crash forensics.
  const toolCallRing = new ToolCallRing();

  // T066 — periodic memory sampler. Danger threshold (default 95%) closes
  // idle instances to reclaim heap before V8 trips OOM. We pick the
  // *least-recently-active* idle instance per tick rather than mass-close
  // so users keep at least one slot alive while the pressure subsides.
  const memoryMonitor = new MemoryMonitor({
    intervalMs: Math.max(1000, args.memSampleIntervalSec * 1000),
    warnPct: args.memWarnPct,
    dangerPct: args.memDangerPct,
    onDanger: async () => {
      // FR-022 self-protection: close one idle instance per danger tick
      // (still ready, no in-flight tool work). Best-effort — failures are
      // swallowed so the sampler keeps running.
      const candidates = registry.list().filter(i => i.state === 'ready');
      const victim = candidates[0];
      if (!victim) {
        return;
      }
      try {
        await victim.close();
        registry.remove(victim.id);
        process.stderr.write(
          `[MemoryMonitor] closed idle instance ${victim.id} to relieve heap pressure\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[MemoryMonitor] failed to close ${victim.id}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  });
  memoryMonitor.start();

  // T067 — install crash logger. Pick the persistent root when the user
  // configured `--artifact-dir`; otherwise fall back to the ephemeral
  // tmpdir slot (still better than dropping the crash on the floor).
  const artifactMgr = getArtifactDirManager({
    persistentRoot: args.artifactDir,
  });
  const artifactDir = args.artifactDir
    ? artifactMgr.getRoot('persistent')
    : artifactMgr.getRoot('ephemeral');
  const crashLogger = new CrashLogger({
    artifactDir,
    collectActiveInstances: () => registry.snapshotHealth(),
    collectMemorySamples: () => memoryMonitor.recentSamples(),
    collectRecentToolCalls: () => toolCallRing.snapshot(),
  });
  crashLogger.install();

  // T075 — runtime observability: ring of per-instance buffer + memory
  // metrics. Periodic stderr emission is opt-in via
  // `--system-observe-interval-sec`; the on-demand `system_observe`
  // tool is always wired below.
  const observability = new Observability({
    registry,
    memoryMonitor,
    artifactPersistentDir: args.artifactDir
      ? artifactMgr.getRoot('persistent')
      : undefined,
    artifactEphemeralDir: artifactMgr.getRoot('ephemeral'),
  });
  if (args.systemObserveIntervalSec > 0) {
    observability.startPeriodicLog(args.systemObserveIntervalSec * 1000);
  }

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
          {
            registry,
            serverArgs: args,
            connectedBrowser,
            authStateHolder,
                    watchdog,
          },
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
              // Stop the existing watchdog's CDP polling, then create a fresh
              // one seeded with the new ConnectedBrowser so the CDP reconnect
              // path has the correct URL / browser handle. The watchdog
              // object itself is replaced so in-flight launch-mode
              // disconnect listeners referencing the old instance still run
              // to completion (they hold a closure over `watchdog`, but
              // `onDisconnect` is self-contained and doesn't rely on
              // `start()`).
              watchdog.stop();
              connectedBrowser = cb;
              watchdog = new ConnectionWatchdog(cb, registry, {
                reconnectMaxAttempts: args.reconnectMaxAttempts,
                reconnectBackoffMs: args.reconnectBackoffMs,
                circuitBreakAfter: args.circuitBreakAfter,
              });
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

  // T058 — instance_health (FR-016)
  server.registerTool(
    'instance_health',
    {
      description:
        'Return a structured health snapshot of every registered instance: lifecycle state (ready/reconnecting/dead), last error, last healthy timestamp, reconnect counter, and whether the service spawned the underlying browser. Cheap to poll during recovery flows.',
      inputSchema: {},
      annotations: {
        title: 'Instance Health',
        readOnlyHint: true,
      },
    },
    async (): Promise<CallToolResult> => {
      return await instanceHealth(registry);
    },
  );

  // T058 — instance_recreate (FR-014)
  server.registerTool(
    'instance_recreate',
    {
      description:
        'Hard-rebuild a registered instance under the same id (preserving the deterministic downloadPath). Idiomatic recovery flow after the watchdog has parked an instance in `dead`. Re-runs auth cloning + badge injection.',
      inputSchema: {
        instanceId: zod
          .string()
          .min(1)
          .describe('Existing instance id to recreate in-place.'),
        url: zod
          .string()
          .optional()
          .describe('Optional URL to load after the new browser is up.'),
        cloneAuth: zod
          .boolean()
          .optional()
          .describe('Clone global AuthState into new instance. Default true.'),
        useCDP: zod
          .boolean()
          .optional()
          .describe(
            'Force CDP / launch (else uses the same default rules as instance_create).',
          ),
      },
      annotations: {
        title: 'Recreate Instance',
        readOnlyHint: false,
      },
    },
    async (params: {
      instanceId: string;
      url?: string;
      cloneAuth?: boolean;
      useCDP?: boolean;
    }): Promise<CallToolResult> => {
      const release = await mutex.acquire(undefined);
      try {
        return await instanceRecreate(params, {
          registry,
          serverArgs: args,
          connectedBrowser,
          authStateHolder,
          watchdog,
        });
      } finally {
        release.dispose();
      }
    },
  );

  // T076 — system_observe (FR-024b)
  server.registerTool(
    'system_observe',
    {
      description:
        'Return a snapshot of runtime observability data: per-instance lifecycle state + console/network buffer occupancy, process memory (RSS / heapUsed / heapPct), and artifact directory disk usage. Pair with `--system-observe-interval-sec` for continuous stderr emission.',
      inputSchema: {
        includeMemorySamples: zod
          .boolean()
          .optional()
          .describe(
            'Embed the rolling MemoryMonitor ring buffer (up to 60 samples). Default false to keep responses small.',
          ),
      },
      annotations: {
        title: 'System Observability Snapshot',
        readOnlyHint: true,
      },
    },
    async (params: {
      includeMemorySamples?: boolean;
    }): Promise<CallToolResult> => {
      return await systemObserve(
        {includeMemorySamples: params.includeMemorySamples},
        observability,
      );
    },
  );

  // T037 — page_artifact_read_summary
  server.registerTool(
    'page_artifact_read_summary',
    {
      description:
        'Return a small JSON summary of an on-disk artifact previously persisted by take_screenshot / performance_stop_trace / take_memory_snapshot / the response-size guard. Avoids round-tripping the raw bytes through the MCP pipe (FR-008).',
      inputSchema: {
        filePath: zod
          .string()
          .min(1)
          .describe(
            'Absolute (or cwd-relative) path to the artifact file. Returned by the persisting tool in `structuredContent.*Persistence.filePath` or `responseGuard.filePath`.',
          ),
        kind: zod
          .enum(['trace', 'heap', 'response'])
          .optional()
          .describe(
            'Override the auto-inferred artifact kind. Inference rules: `.heapsnapshot` → heap, `.json.gz` → trace, `.json` under `responses/` → response, other `.json` → trace.',
          ),
        sliceStart: zod
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Byte offset for the start of the text slice. Only honoured when kind=`response`. Defaults to 0.',
          ),
        sliceEnd: zod
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Byte offset for the end of the text slice. Only honoured when kind=`response`. Defaults to sliceStart + 4096.',
          ),
      },
      annotations: {
        title: 'Read Artifact Summary',
        readOnlyHint: true,
      },
    },
    async (params: {
      filePath: string;
      kind?: 'trace' | 'heap' | 'response';
      sliceStart?: number;
      sliceEnd?: number;
    }): Promise<CallToolResult> => {
      return await artifactReadSummary({
        filePath: params.filePath,
        kind: params.kind,
        sliceStart: params.sliceStart,
        sliceEnd: params.sliceEnd,
      });
    },
  );

  // --- Derive page_* tools from upstream ---
  const upstreamTools = createTools(args);
  for (const tool of upstreamTools) {
    // Skip disabled tools (FR-008)
    if (isToolDisabled(tool, args)) {
      continue;
    }

    const derived = derivePageTool(tool, {
      registry,
      mutex,
      serverArgs: args,
      toolCallRing,
    });

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
      notifier.detach();
      observability.stop();
      memoryMonitor.stop();
      crashLogger.uninstall();
      watchdog.stop();
      await instanceCloseAll(registry);
      await server.close();
    },
  };
}

export type {ParallelServerArgs} from './types.js';
