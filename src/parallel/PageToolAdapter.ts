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

import type {InstanceMutex} from './InstanceMutex.js';
import type {InstanceRegistry} from './InstanceRegistry.js';
import {processSnapshot} from './SnapshotEnhancer.js';
import type {ParallelServerArgs} from './types.js';

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

  // Dispatch function
  async function dispatch(
    params: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const instanceId = params.instanceId;
    if (typeof instanceId !== 'string' || instanceId.length === 0) {
      return {
        content: [{type: 'text', text: 'instanceId is required.'}],
        isError: true,
      };
    }

    // Step 1: lookup
    const instance = deps.registry.get(instanceId);
    if (!instance) {
      return {
        content: [{type: 'text', text: `Instance ${instanceId} not found.`}],
        isError: true,
      };
    }

    // Step 2: availability
    if (!instance.available) {
      return {
        content: [
          {
            type: 'text',
            text: `Instance ${instanceId} is currently unavailable (connection lost, retrying)...`,
          },
        ],
        isError: true,
      };
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
        if ('pageScoped' in upstream && upstream.pageScoped) {
          await handler({params: upstreamParams, page}, response, context);
        } else {
          await handler({params: upstreamParams}, response, context);
        }
      } catch (err) {
        response.setError(err);
      }

      // Step 6: generate result
      const handleResult = await response.handle(upstream.name, context);
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

      // Step 8: telemetry placeholder
      logger(
        `${name} dispatched to instance ${instanceId}: success=${!result.isError}`,
      );

      return result;
    } finally {
      release.dispose();
    }
  }

  return {
    name,
    description,
    schema: derivedSchema,
    annotations,
    dispatch,
  };
}
