/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import {getArtifactDirManager} from '../utils/artifactDir.js';
import {ensureExtension} from '../utils/files.js';
import {summarizeHeapSnapshot} from '../utils/heapSnapshotSummary.js';
import {
  StructuredError,
  StructuredErrorCode,
} from '../utils/structuredError.js';

import {ToolCategory} from './categories.js';
import {definePageTool, defineTool} from './ToolDefinition.js';

export const takeMemorySnapshot = definePageTool({
  name: 'take_memory_snapshot',
  description: `Capture a heap snapshot of the currently selected page. Use to analyze the memory distribution of JavaScript objects and debug memory leaks. By default the snapshot is persisted to the artifact directory and the response carries only \`{filePath, sizeBytes, topNodeKinds}\` to keep the MCP pipe small (FR-008).`,
  annotations: {
    category: ToolCategory.MEMORY,
    readOnlyHint: false,
  },
  schema: {
    filePath: zod
      .string()
      .optional()
      .describe(
        'Optional absolute path (or path relative to cwd) to write the .heapsnapshot to. When omitted the file is allocated under the configured artifact directory (`--artifact-dir`) or the per-pid ephemeral root.',
      ),
  },
  blockedByDialog: true,
  handler: async (request, response, context) => {
    const page = request.page;

    let targetPath: string;
    if (request.params.filePath) {
      context.validatePath(request.params.filePath);
      targetPath = ensureExtension(request.params.filePath, '.heapsnapshot');
    } else {
      // FR-008 — force-persist via the central ArtifactDirManager so artifacts
      // share lifetime semantics with screenshots / traces / oversize responses.
      const allocated = getArtifactDirManager().allocate(
        'heapsnapshots',
        'page',
        '.heapsnapshot',
      );
      targetPath = allocated.filePath;
    }

    try {
      await page.pptrPage.captureHeapSnapshot({path: targetPath});
    } catch (err) {
      throw new StructuredError({
        code: StructuredErrorCode.DISK_WRITE_FAILED,
        message: `Failed to capture heap snapshot to ${targetPath}.`,
        recoverable: true,
        nextAction:
          'Verify the artifact directory is writable, or pass an explicit `filePath`. See `--artifact-dir`.',
        detail: {targetPath},
        cause: err instanceof Error ? err : undefined,
      });
    }

    const summary = await summarizeHeapSnapshot(targetPath);
    response.appendResponseLine(
      `Heap snapshot saved to ${summary.filePath} (${summary.sizeBytes} bytes).`,
    );
    response.setHeapSnapshotPersistence(summary);
  },
});

export const exploreMemorySnapshot = defineTool({
  name: 'load_memory_snapshot',
  description:
    'Loads a memory heapsnapshot and returns snapshot summary stats.',
  annotations: {
    category: ToolCategory.MEMORY,
    readOnlyHint: true,
    conditions: ['experimentalMemory'],
  },
  schema: {
    filePath: zod.string().describe('A path to a .heapsnapshot file to read.'),
  },
  blockedByDialog: false,
  handler: async (request, response, context) => {
    context.validatePath(request.params.filePath);
    const stats = await context.getHeapSnapshotStats(request.params.filePath);
    const staticData = await context.getHeapSnapshotStaticData(
      request.params.filePath,
    );

    response.setHeapSnapshotStats(stats, staticData);
  },
});

export const getMemorySnapshotDetails = defineTool({
  name: 'get_memory_snapshot_details',
  description:
    'Loads a memory heapsnapshot and returns all available information including statistics, static data, and aggregated node information. Supports pagination for aggregates.',
  annotations: {
    category: ToolCategory.MEMORY,
    readOnlyHint: true,
    conditions: ['experimentalMemory'],
  },
  schema: {
    filePath: zod.string().describe('A path to a .heapsnapshot file to read.'),
    pageIdx: zod
      .number()
      .optional()
      .describe('The page index for pagination of aggregates.'),
    pageSize: zod
      .number()
      .optional()
      .describe('The page size for pagination of aggregates.'),
  },
  blockedByDialog: false,
  handler: async (request, response, context) => {
    context.validatePath(request.params.filePath);
    const aggregates = await context.getHeapSnapshotAggregates(
      request.params.filePath,
    );

    response.setHeapSnapshotAggregates(aggregates, {
      pageIdx: request.params.pageIdx,
      pageSize: request.params.pageSize,
    });
  },
});

export const getNodesByClass = defineTool({
  name: 'get_nodes_by_class',
  description:
    'Loads a memory heapsnapshot and returns instances of a specific class with their stable IDs.',
  annotations: {
    category: ToolCategory.MEMORY,
    readOnlyHint: true,
    conditions: ['experimentalMemory'],
  },
  schema: {
    filePath: zod.string().describe('A path to a .heapsnapshot file to read.'),
    uid: zod
      .number()
      .describe(
        'The unique UID for the class, obtained from aggregates listing.',
      ),
    pageIdx: zod.number().optional().describe('The page index for pagination.'),
    pageSize: zod.number().optional().describe('The page size for pagination.'),
  },
  blockedByDialog: false,
  handler: async (request, response, context) => {
    context.validatePath(request.params.filePath);
    const nodes = await context.getHeapSnapshotNodesByUid(
      request.params.filePath,
      request.params.uid,
    );

    response.setHeapSnapshotNodes(nodes, {
      pageIdx: request.params.pageIdx,
      pageSize: request.params.pageSize,
    });
  },
});
