/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Structured error envelope for stability hardening (FR-026).
 * All tools that need to surface a recoverable / actionable failure to the
 * caller MUST use StructuredError + toToolResult so the response is uniform.
 *
 * See specs/001-stability-hardening/plan.md WP-5 + tasks.md T010.
 */

import type {CallToolResult} from '../third_party/index.js';

/**
 * CallToolResult variant with the `structuredContent` extension field used by
 * MCP clients that opt into it. The upstream MCP SDK type does not include
 * the field today, so we widen it locally without using `as`.
 */
export interface StructuredCallToolResult extends CallToolResult {
  structuredContent?: Record<string, unknown>;
}

export const StructuredErrorCode = {
  INSTANCE_DEAD: 'INSTANCE_DEAD',
  INSTANCE_RECONNECTING: 'INSTANCE_RECONNECTING',
  INSTANCE_PROTOCOL_ERROR: 'INSTANCE_PROTOCOL_ERROR',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  INLINE_PAYLOAD_TOO_LARGE: 'INLINE_PAYLOAD_TOO_LARGE',
  DISK_WRITE_FAILED: 'DISK_WRITE_FAILED',
  RECORD_TOO_LARGE: 'RECORD_TOO_LARGE',
} as const;

export type StructuredErrorCodeValue =
  (typeof StructuredErrorCode)[keyof typeof StructuredErrorCode];

export interface StructuredErrorInit {
  code: StructuredErrorCodeValue;
  message: string;
  recoverable: boolean;
  nextAction: string;
  cause?: unknown;
  /** Free-form structured detail merged into structuredContent. */
  detail?: Record<string, unknown>;
}

export class StructuredError extends Error {
  readonly code: StructuredErrorCodeValue;
  readonly recoverable: boolean;
  readonly nextAction: string;
  readonly detail: Record<string, unknown>;

  constructor(init: StructuredErrorInit) {
    super(init.message);
    this.name = 'StructuredError';
    this.code = init.code;
    this.recoverable = init.recoverable;
    this.nextAction = init.nextAction;
    this.detail = init.detail ?? {};
    if (init.cause !== undefined) {
      // Set cause via property descriptor to avoid TS DOM lib mismatch.
      Object.defineProperty(this, 'cause', {
        value: init.cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      nextAction: this.nextAction,
      ...this.detail,
    };
  }
}

export function isStructuredError(err: unknown): err is StructuredError {
  return err instanceof StructuredError;
}

export function toToolResult(err: StructuredError): StructuredCallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `[${err.code}] ${err.message} (next: ${err.nextAction})`,
      },
    ],
    structuredContent: err.toJSON(),
  };
}
