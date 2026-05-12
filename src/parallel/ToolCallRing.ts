/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * ToolCallRing (T067 helper / FR-023).
 *
 * Capped FIFO of the most-recent tool invocations the parallel server
 * has dispatched. Used by `CrashLogger` to attach forensic context to
 * crash reports without paying the cost of full request/response capture.
 *
 * Records intentionally exclude raw params and full results so we don't
 * accidentally persist secrets or megabyte-class trace payloads. Only
 * coarse metadata (tool name, instance id, duration, ok/err) is kept.
 */

const DEFAULT_CAPACITY = 20;

export interface ToolCallRecord {
  readonly atIso: string;
  readonly atMs: number;
  readonly tool: string;
  readonly instanceId: string | null;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly errorCode: string | null;
}

export class ToolCallRing {
  readonly #capacity: number;
  readonly #ring: ToolCallRecord[] = [];

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.#capacity = capacity > 0 ? capacity : DEFAULT_CAPACITY;
  }

  record(entry: Omit<ToolCallRecord, 'atIso' | 'atMs'>): void {
    const now = Date.now();
    const full: ToolCallRecord = {
      atIso: new Date(now).toISOString(),
      atMs: now,
      ...entry,
    };
    this.#ring.push(full);
    while (this.#ring.length > this.#capacity) {
      this.#ring.shift();
    }
  }

  /** Defensive copy, oldest first. */
  snapshot(): readonly ToolCallRecord[] {
    return [...this.#ring];
  }

  clear(): void {
    this.#ring.length = 0;
  }
}
