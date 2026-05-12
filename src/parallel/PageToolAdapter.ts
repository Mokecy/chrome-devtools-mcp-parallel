/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * PageToolAdapter: derives page_* tools from upstream ToolDefinitions.
 * See specs/001-parallel-instances/contracts/page-tool-derivation.md.
 *
 * Phase 3 basic version — covers schema rewrite + dispatch steps 1–6, 8.
 * Step 7 (snapshot enhancement) is a no-op until US4 (T053).
 */

import {logger} from '../logger.js';
import {McpResponse} from '../McpResponse.js';
import {SlimMcpResponse} from '../SlimMcpResponse.js';
import {zod} from '../third_party/index.js';
import type {CallToolResult} from '../third_party/index.js';
import type {ToolDefinition} from '../tools/ToolDefinition.js';
import {getArtifactDirManager} from '../utils/artifactDir.js';
import {applyResponseSizeGuard} from '../utils/responseSizeGuard.js';
import {
  StructuredError,
  StructuredErrorCode,
  toToolResult as structuredErrorToToolResult,
} from '../utils/structuredError.js';

import type {InstanceMutex} from './InstanceMutex.js';
import type {InstanceRegistry} from './InstanceRegistry.js';
import {processSnapshot} from './SnapshotEnhancer.js';
import type {ToolCallRing} from './ToolCallRing.js';
import type {Instance, ParallelServerArgs} from './types.js';

/**
 * FR-013 — how long the dispatcher waits for a `reconnecting` instance to
 * either come back to `ready` or settle into `dead` before returning a
 * structured `INSTANCE_RECONNECTING` error to the caller.
 */
const RECONNECT_GATE_TIMEOUT_MS = 10_000;
const RECONNECT_GATE_POLL_MS = 100;

async function waitForReadyOrDead(
  instance: Instance,
  timeoutMs: number,
): Promise<'ready' | 'reconnecting' | 'dead'> {
  if (instance.state !== 'reconnecting') {
    return instance.state;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, RECONNECT_GATE_POLL_MS));
    if (instance.state !== 'reconnecting') {
      return instance.state;
    }
  }
  return instance.state;
}

/**
 * Internal soft timeout (ms) for the upstream handler + response.handle().
 * Kept below the typical MCP client timeout (60s) so we can return a
 * meaningful error and release the per-instance mutex instead of letting the
 * client time out and the server keep the page busy.
 */
const HANDLER_SOFT_TIMEOUT_MS = 55_000;

/** Tools that frequently produce huge payloads on heavy pages. */
const HEAVY_PAYLOAD_TOOLS = new Set<string>([
  'take_snapshot',
  'take_screenshot',
]);

class HandlerTimeoutError extends Error {
  constructor(toolName: string, ms: number) {
    super(
      `Tool "${toolName}" exceeded ${ms}ms internal timeout. ` +
        (HEAVY_PAYLOAD_TOOLS.has(toolName)
          ? 'Try passing a "filePath" to save the result to disk, ' +
            'or set "verbose: false" for snapshots on large pages.'
          : 'The page may be unresponsive; consider page_close_page or instance_close.'),
    );
    this.name = 'HandlerTimeoutError';
  }
}

/**
 * Best-effort extraction of a structured error code from a result. The
 * health gate stamps `INSTANCE_DEAD` / `INSTANCE_RECONNECTING` etc. into
 * the structured payload (and as a substring of the human text) — we
 * sniff that for the crash ring without re-parsing the full JSON.
 */
function extractErrorCode(result: CallToolResult): string | null {
  if (!result.isError) {
    return null;
  }
  const first = result.content[0];
  if (first && 'text' in first && typeof first.text === 'string') {
    const m =
      /\b(INSTANCE_DEAD|INSTANCE_RECONNECTING|DISK_WRITE_FAILED|HandlerTimeoutError)\b/.exec(
        first.text,
      );
    if (m) {
      return m[1];
    }
  }
  return 'ERROR';
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HandlerTimeoutError(toolName, ms)),
      ms,
    );
    p.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface DerivedToolInfo {
  name: string;
  description: string;
  schema: zod.ZodRawShape;
  annotations: ToolDefinition['annotations'];
  dispatch: (params: Record<string, unknown>) => Promise<CallToolResult>;
}

/**
 * Derive a page_* tool from an upstream ToolDefinition.
 */
export function derivePageTool(
  upstream: ToolDefinition,
  deps: {
    registry: InstanceRegistry;
    mutex: InstanceMutex;
    serverArgs: ParallelServerArgs;
    /**
     * Optional capped ring of recent tool calls — populated for crash
     * forensics (FR-023). When provided, the adapter records one entry
     * per dispatch with coarse metadata only.
     */
    toolCallRing?: ToolCallRing;
  },
): DerivedToolInfo {
  const name = `page_${upstream.name}`;
  const description = `[Parallel] ${upstream.description} (operates on specified instance)`;

  // Build derived schema: prepend instanceId
  const instanceIdField = {
    instanceId: zod.string().min(1).describe('Target instance id'),
  };
  const derivedSchema = {...instanceIdField, ...upstream.schema};

  // Annotations pass through
  const annotations = upstream.annotations;

  async function dispatchInner(
    params: Record<string, unknown>,
  ): Promise<{result: CallToolResult; instanceId: string | null}> {
    const instanceId = params.instanceId;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      return {
        result: {
          content: [{type: 'text', text: 'instanceId is required.'}],
          isError: true,
        },
        instanceId: null,
      };
    }

    // Step 1: lookup
    const instance = deps.registry.get(instanceId);
    if (!instance) {
      const known = deps.registry.list().map(i => i.id);
      const knownLine = known.length
        ? ` Active instances: ${known.join(', ')}.`
        : ' No active instances in this server process (the server may have been restarted; previously launched browser windows can be left orphaned).';
      return {
        result: {
          content: [
            {
              type: 'text',
              text:
                `Instance "${instanceId}" not found.${knownLine} ` +
                `Use instance_create to (re-)create it, or instance_list to see what's tracked.`,
            },
          ],
          isError: true,
        },
        instanceId,
      };
    }

    // Step 2: availability — FR-013 health gate.
    //   dead         → INSTANCE_DEAD (immediate, structured, hint to recreate)
    //   reconnecting → wait up to RECONNECT_GATE_TIMEOUT_MS for the watchdog
    //                  to settle; on timeout return INSTANCE_RECONNECTING.
    //   ready        → fall through to the per-instance lock + handler.
    if (instance.state === 'dead') {
      return {
        result: structuredErrorToToolResult(
          new StructuredError({
            code: StructuredErrorCode.INSTANCE_DEAD,
            message: `Instance ${instanceId} is dead${
              instance.lastError ? ` (${instance.lastError})` : ''
            }.`,
            recoverable: true,
            nextAction:
              'Call `instance_recreate` to rebuild the browser, or `instance_create` for a new id.',
            detail: {instanceId, lastError: instance.lastError},
          }),
        ),
        instanceId,
      };
    }
    if (instance.state === 'reconnecting') {
      const settled = await waitForReadyOrDead(
        instance,
        RECONNECT_GATE_TIMEOUT_MS,
      );
      if (settled === 'dead') {
        return {
          result: structuredErrorToToolResult(
            new StructuredError({
              code: StructuredErrorCode.INSTANCE_DEAD,
              message: `Instance ${instanceId} died during reconnect${
                instance.lastError ? ` (${instance.lastError})` : ''
              }.`,
              recoverable: true,
              nextAction: 'Call `instance_recreate` to rebuild the browser.',
              detail: {instanceId, lastError: instance.lastError},
            }),
          ),
          instanceId,
        };
      }
      if (settled !== 'ready') {
        return {
          result: structuredErrorToToolResult(
            new StructuredError({
              code: StructuredErrorCode.INSTANCE_RECONNECTING,
              message: `Instance ${instanceId} is still reconnecting after ${RECONNECT_GATE_TIMEOUT_MS}ms (attempt #${instance.reconnectAttempts}).`,
              recoverable: true,
              nextAction:
                'Retry the call after a short delay, or query `instance_health` to inspect the watchdog state.',
              detail: {
                instanceId,
                reconnectAttempts: instance.reconnectAttempts,
                lastError: instance.lastError,
              },
            }),
          ),
          instanceId,
        };
      }
    }

    // Step 3: acquire per-instance lock
    const release = await deps.mutex.acquire(instanceId);
    try {
      // Strip instanceId from params before passing to upstream
      const upstreamParams = {...params};
      delete upstreamParams.instanceId;

      // Step 4: prepare response & page
      const response = deps.serverArgs.slim
        ? new SlimMcpResponse(deps.serverArgs)
        : new McpResponse(deps.serverArgs);
      response.setRedactNetworkHeaders(
        deps.serverArgs.redactNetworkHeaders ?? false,
      );

      const context = instance.mcpContext;
      // Ensure pages are refreshed and a page is selected.
      // CDP-mode contexts may have no page initially; lazily create one.
      let page;
      try {
        page = context.getSelectedMcpPage();
      } catch {
        // No page selected yet — refresh and retry, creating one if needed.
        const pages = await context.createPagesSnapshot();
        if (pages.length === 0) {
          await instance.context.newPage();
          await context.createPagesSnapshot();
        }
        page = context.getSelectedMcpPage();
      }
      response.setPage(page);

      if (upstream.blockedByDialog) {
        page.throwIfDialogOpen();
      }

      // Step 5: delegate to upstream handler
      // The handler signature uses generic Schema which we cannot statically satisfy
      // here since we dispatch dynamically. We pass the structurally-correct request
      // object; runtime validation is handled by the upstream handler itself.
      const handler: (
        req: {params: Record<string, unknown>; page?: unknown},
        res: typeof response,
        ctx: typeof context,
      ) => Promise<void> = upstream.handler;
      try {
        const exec = (async () => {
          if ('pageScoped' in upstream && upstream.pageScoped) {
            await handler({params: upstreamParams, page}, response, context);
          } else {
            await handler({params: upstreamParams}, response, context);
          }
        })();
        await withTimeout(exec, HANDLER_SOFT_TIMEOUT_MS, upstream.name);
      } catch (err) {
        response.setError(err);
      }

      // Step 6: generate result (also bounded so a slow snapshot/network
      // collection cannot hang the per-instance mutex past the client timeout).
      const handleResult = await withTimeout(
        response.handle(upstream.name, context),
        HANDLER_SOFT_TIMEOUT_MS,
        upstream.name,
      );
      const result: CallToolResult = {content: handleResult.content};
      if (response.error) {
        result.isError = true;
      }
      if (
        deps.serverArgs.experimentalStructuredContent &&
        handleResult.structuredContent
      ) {
        // structuredContent is an extension field supported by some MCP clients
        Object.assign(result, {
          structuredContent: handleResult.structuredContent,
        });
      }

      // Step 7: snapshot enhancement (T053)
      if (upstream.name === 'take_snapshot' && !result.isError) {
        const textContent = result.content.find(c => c.type === 'text');
        if (textContent && 'text' in textContent) {
          try {
            const pptrPage = page.pptrPage;
            const enhanced = await processSnapshot({
              text: textContent.text,
              prev: instance.prevSnapshot,
              prevOrigin: instance.prevSnapshotOrigin,
              page: pptrPage,
              currentOrigin: pptrPage.url(),
            });
            textContent.text = enhanced.text;
            instance.prevSnapshot = enhanced.canonical;
            instance.prevSnapshotOrigin = enhanced.origin;
          } catch {
            // Enhancement failed; return raw snapshot
          }
        }
      }

      // Step 8a: response size guard (FR-008 / T032). Last mile before the
      // payload leaves the server — multi-MB JSON gets persisted to disk and
      // replaced with a small descriptor so the MCP pipe never blocks.
      const maxBytes = Math.max(
        0,
        Math.floor(deps.serverArgs.maxResponseSizeMb * 1024 * 1024),
      );
      let finalResult: CallToolResult = result;
      if (maxBytes > 0) {
        try {
          const artifactDir = getArtifactDirManager({
            persistentRoot: deps.serverArgs.artifactDir,
          });
          const guarded = applyResponseSizeGuard(result, {
            artifactDir,
            maxBytes,
            instanceId,
            toolName: upstream.name,
          });
          finalResult = guarded.result;
          if (guarded.truncated) {
            logger(
              `${name} response oversized (${guarded.originalSize}b > ${maxBytes}b) — persisted to ${guarded.filePath}`,
            );
          }
        } catch (err) {
          // Guard must never crash the dispatch path.
          logger(
            `${name} response size guard failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Step 8b: telemetry placeholder.
      logger(
        `${name} dispatched to instance ${instanceId}: success=${!finalResult.isError}`,
      );

      return {result: finalResult, instanceId};
    } finally {
      release.dispose();
    }
  }

  async function dispatch(
    params: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const startedAtMs = Date.now();
    const {result, instanceId} = await dispatchInner(params);
    if (deps.toolCallRing) {
      deps.toolCallRing.record({
        tool: name,
        instanceId,
        durationMs: Date.now() - startedAtMs,
        ok: !result.isError,
        errorCode: extractErrorCode(result),
      });
    }
    return result;
  }

  return {
    name,
    description,
    schema: derivedSchema,
    annotations,
    dispatch,
  };
}
