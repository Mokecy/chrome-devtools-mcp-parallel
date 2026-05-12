/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * page_artifact_read_summary management tool — FR-008 / T036.
 *
 * Lets a caller ask for a small JSON summary of an artifact previously
 * persisted by `take_screenshot` / `performance_stop_trace` /
 * `take_memory_snapshot` / the response-size guard, without ever
 * shipping the raw bytes back through the MCP pipe.
 *
 * Input schema:
 *   - filePath  (required) absolute or cwd-relative path
 *   - kind      (optional) 'trace' | 'heap' | 'response' — inferred from
 *               extension when omitted
 *   - sliceStart / sliceEnd (optional) byte offsets into the
 *               raw-text view of a `response` artifact, ignored otherwise
 *
 * Output: structured JSON describing the artifact + a short text line.
 * Failures are surfaced via `StructuredError(DISK_WRITE_FAILED)` so the
 * caller's recovery loop is uniform.
 */

import {promises as fs} from 'node:fs';
import path from 'node:path';

import type {CallToolResult} from '../../third_party/index.js';
import {
  parseRawTraceBuffer,
  traceResultIsSuccess,
} from '../../trace-processing/parse.js';
import {summarizeHeapSnapshot} from '../../utils/heapSnapshotSummary.js';
import {
  StructuredError,
  StructuredErrorCode,
  toToolResult,
} from '../../utils/structuredError.js';
import {summarizeRawBuffer, summarizeTrace} from '../../utils/traceSummary.js';

export type ArtifactKind = 'trace' | 'heap' | 'response';

export interface ArtifactReadSummaryInput {
  filePath: string;
  kind?: ArtifactKind;
  sliceStart?: number;
  sliceEnd?: number;
}

const TRACE_EXTS = new Set(['.json.gz', '.json']);
const HEAP_EXTS = new Set(['.heapsnapshot']);

function inferKind(filePath: string): ArtifactKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.heapsnapshot')) {
    return 'heap';
  }
  if (lower.endsWith('.json.gz')) {
    return 'trace';
  }
  if (lower.endsWith('.json')) {
    // Both traces and oversized responses live under .json. Heuristic:
    // anything under a `responses/` folder is a response, everything else
    // is a trace.
    if (
      lower.includes(`${path.sep}responses${path.sep}`) ||
      lower.includes('/responses/')
    ) {
      return 'response';
    }
    return 'trace';
  }
  return 'response';
}

export async function artifactReadSummary(
  input: ArtifactReadSummaryInput,
): Promise<CallToolResult> {
  const filePath = path.resolve(input.filePath);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return toToolResult(
      new StructuredError({
        code: StructuredErrorCode.DISK_WRITE_FAILED,
        message: `Cannot read artifact at ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        recoverable: true,
        nextAction:
          'Verify the path exists and the process has read permission. Use `instance_list` / earlier tool responses to confirm the path.',
        detail: {filePath, op: 'stat'},
        cause: err instanceof Error ? err : undefined,
      }),
    );
  }

  const kind: ArtifactKind = input.kind ?? inferKind(filePath);

  if (kind === 'heap') {
    return summarizeHeap(filePath, stat.size);
  }
  if (kind === 'trace') {
    return summarizeTraceArtifact(filePath, stat.size);
  }
  return summarizeResponse(
    filePath,
    stat.size,
    input.sliceStart,
    input.sliceEnd,
  );
}

async function summarizeHeap(
  filePath: string,
  sizeBytes: number,
): Promise<CallToolResult> {
  const summary = await summarizeHeapSnapshot(filePath);
  const lines = [
    `Heap snapshot summary for ${filePath}`,
    `Size: ${sizeBytes} bytes`,
  ];
  if (summary.topNodeKinds.length) {
    lines.push(
      `Top node kinds: ${summary.topNodeKinds
        .map(b => `${b.kind}=${b.count}`)
        .join(', ')}`,
    );
  }
  return {
    content: [{type: 'text', text: lines.join('\n')}],
    structuredContent: {
      kind: 'heap',
      filePath: summary.filePath,
      sizeBytes: summary.sizeBytes,
      topNodeKinds: summary.topNodeKinds,
    },
  };
}

async function summarizeTraceArtifact(
  filePath: string,
  sizeBytes: number,
): Promise<CallToolResult> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (err) {
    return toToolResult(
      new StructuredError({
        code: StructuredErrorCode.DISK_WRITE_FAILED,
        message: `Failed to read trace at ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        recoverable: true,
        nextAction:
          'Verify the file is readable and is a valid trace JSON. Compressed `.json.gz` traces must be decompressed before re-summarizing.',
        detail: {filePath, op: 'readFile'},
        cause: err instanceof Error ? err : undefined,
      }),
    );
  }

  const parsed = await parseRawTraceBuffer(buffer);
  const summary = traceResultIsSuccess(parsed)
    ? summarizeTrace(buffer, parsed)
    : summarizeRawBuffer(buffer);

  const cm = summary.coreMetrics;
  const cmParts: string[] = [];
  if (typeof cm.lcpMs === 'number') {
    cmParts.push(`LCP=${cm.lcpMs}ms`);
  }
  if (typeof cm.inpMs === 'number') {
    cmParts.push(`INP=${cm.inpMs}ms`);
  }
  if (typeof cm.clsScore === 'number') {
    cmParts.push(`CLS=${cm.clsScore}`);
  }
  const lines = [
    `Trace summary for ${filePath}`,
    `Size: ${sizeBytes} bytes; events: ${summary.events}; samplingWindowMs: ${summary.samplingWindowMs}`,
  ];
  if (cmParts.length) {
    lines.push(`Core metrics: ${cmParts.join(', ')}`);
  }

  return {
    content: [{type: 'text', text: lines.join('\n')}],
    structuredContent: {
      kind: 'trace',
      filePath,
      sizeBytes,
      summary,
    },
  };
}

async function summarizeResponse(
  filePath: string,
  sizeBytes: number,
  sliceStart: number | undefined,
  sliceEnd: number | undefined,
): Promise<CallToolResult> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return toToolResult(
      new StructuredError({
        code: StructuredErrorCode.DISK_WRITE_FAILED,
        message: `Failed to read response artifact at ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        recoverable: true,
        nextAction: 'Verify the file exists and is readable.',
        detail: {filePath, op: 'readFile'},
        cause: err instanceof Error ? err : undefined,
      }),
    );
  }

  let topLevelKeys: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      topLevelKeys = Object.keys(parsed);
    } else if (Array.isArray(parsed)) {
      topLevelKeys = ['<array>', `length=${parsed.length}`];
    }
  } catch {
    // not JSON — leave keys empty, the slice still works
  }

  const start = typeof sliceStart === 'number' ? Math.max(0, sliceStart) : 0;
  const end =
    typeof sliceEnd === 'number'
      ? Math.min(text.length, Math.max(start, sliceEnd))
      : Math.min(text.length, start + 4096);
  const slice = text.slice(start, end);

  const lines = [
    `Response artifact summary for ${filePath}`,
    `Size: ${sizeBytes} bytes; topLevelKeys: ${topLevelKeys.length ? topLevelKeys.join(', ') : '(none)'}`,
    `Slice [${start}..${end}) (${slice.length} chars):`,
    slice,
  ];

  return {
    content: [{type: 'text', text: lines.join('\n')}],
    structuredContent: {
      kind: 'response',
      filePath,
      sizeBytes,
      topLevelKeys,
      slice: {
        start,
        end,
        text: slice,
      },
    },
  };
}

// Re-exported for ergonomic typing in tests / index.ts
export {TRACE_EXTS, HEAP_EXTS};
