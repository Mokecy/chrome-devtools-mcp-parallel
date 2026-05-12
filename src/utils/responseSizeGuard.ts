/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * ResponseSizeGuard — last-mile bouncer for tool responses (FR-008 / SC-002).
 *
 * Any `CallToolResult` whose serialized JSON exceeds the configured
 * `maxBytes` is persisted to `<artifactDir>/responses/...` and replaced with
 * a small descriptor `{ truncated: true, filePath, originalSize }` so the
 * MCP pipe never carries multi-MB blobs that block stdio.
 *
 * The schema-level contract (FR-025) is preserved: the substituted result
 * still has `content: [...]`, still has the same `isError` flag, and still
 * exposes the same top-level fields a caller may have indexed; the new
 * `structuredContent.responseGuard = { truncated, filePath, originalSize }`
 * is purely additive.
 *
 * See specs/001-stability-hardening/tasks.md T032.
 */

import {writeFileSync} from 'node:fs';

import type {CallToolResult} from '../third_party/index.js';

import type {ArtifactDirManager} from './artifactDir.js';
import {
  StructuredError,
  StructuredErrorCode,
  toToolResult,
} from './structuredError.js';

export interface ResponseSizeGuardOptions {
  artifactDir: ArtifactDirManager;
  maxBytes: number;
  instanceId: string;
  toolName: string;
}

export interface GuardOutcome {
  /** The final result the caller should hand back to the MCP client. */
  result: CallToolResult;
  /** True when the original response was offloaded to disk. */
  truncated: boolean;
  /** Original payload length (bytes), present iff `truncated`. */
  originalSize?: number;
  /** Absolute path of the persisted JSON, present iff `truncated`. */
  filePath?: string;
}

/**
 * Estimate JSON byte length without retaining the serialized string. We use
 * `Buffer.byteLength` so the count matches what the MCP transport would
 * actually push through the pipe (UTF-8 bytes, not character count).
 */
export function estimateResponseBytes(result: CallToolResult): number {
  // JSON.stringify is the canonical wire shape for MCP results.
  const json = JSON.stringify(result);
  return Buffer.byteLength(json, 'utf8');
}

export function applyResponseSizeGuard(
  result: CallToolResult,
  options: ResponseSizeGuardOptions,
): GuardOutcome {
  if (options.maxBytes <= 0) {
    return {result, truncated: false};
  }
  const size = estimateResponseBytes(result);
  if (size <= options.maxBytes) {
    return {result, truncated: false};
  }

  let allocated;
  try {
    allocated = options.artifactDir.allocate(
      'responses',
      `${options.instanceId}-${options.toolName}`,
      'json',
    );
    writeFileSync(allocated.filePath, JSON.stringify(result), 'utf8');
  } catch (err) {
    // If we cannot persist the oversize result, surface a structured error
    // rather than letting an N-MB payload through.
    const cause = err instanceof Error ? err : new Error(String(err));
    const fail = new StructuredError({
      code: StructuredErrorCode.DISK_WRITE_FAILED,
      message: `Failed to persist oversize tool response (${size} bytes) for tool=${options.toolName}: ${cause.message}`,
      recoverable: true,
      nextAction:
        'Check disk space / artifact-dir permissions, or reduce response size.',
      cause,
      detail: {
        toolName: options.toolName,
        instanceId: options.instanceId,
        originalSize: size,
      },
    });
    return {
      result: toToolResult(fail),
      truncated: true,
      originalSize: size,
    };
  }

  const replacement: CallToolResult = {
    isError: result.isError,
    content: [
      {
        type: 'text',
        text:
          `[Response oversized — ${size} bytes > ${options.maxBytes} cap; ` +
          `persisted to ${allocated.filePath}. ` +
          `Use page_artifact_read_summary to inspect.]`,
      },
    ],
  };
  Object.assign(replacement, {
    structuredContent: {
      responseGuard: {
        truncated: true,
        filePath: allocated.filePath,
        originalSize: size,
        toolName: options.toolName,
        instanceId: options.instanceId,
      },
    },
  });

  return {
    result: replacement,
    truncated: true,
    originalSize: size,
    filePath: allocated.filePath,
  };
}
