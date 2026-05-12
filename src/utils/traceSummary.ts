/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lightweight trace summarizer for FR-008 (Trace disk persistence).
 * Derives a small JSON-safe envelope from a (possibly already parsed)
 * trace buffer so the MCP response can stay tiny while the full trace
 * lives on disk under `<artifactDir>/traces/`.
 *
 *   - events            : count of raw trace events (cheap, JSON-only)
 *   - samplingWindowMs  : Meta.traceBounds.range / 1000 (µs → ms)
 *   - coreMetrics       : best-effort LCP / CLS / INP from the first
 *                         insightSet, when present
 *
 * See specs/001-stability-hardening/tasks.md T034.
 */

import type {TraceResult} from '../trace-processing/parse.js';

export interface CoreMetrics {
  lcpMs?: number;
  clsScore?: number;
  inpMs?: number;
}

export interface TraceSummary {
  events: number;
  samplingWindowMs: number;
  coreMetrics: CoreMetrics;
}

/**
 * Parse the raw trace buffer just enough to count events without invoking
 * the trace engine again. The DevTools engine has already validated the
 * shape by the time we get here, so the JSON.parse cannot reasonably fail
 * — but if it does we fall back to 0 and let the persisted file be the
 * source of truth.
 */
export function countEvents(buffer: Uint8Array): number {
  try {
    const text = new TextDecoder().decode(buffer);
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
    if (parsed && typeof parsed === 'object') {
      const events = Reflect.get(parsed, 'traceEvents');
      if (Array.isArray(events)) {
        return events.length;
      }
    }
  } catch {
    // fall through
  }
  return 0;
}

/**
 * Pull `samplingWindowMs` out of the parsed trace's Meta.traceBounds.range
 * (microseconds). DevTools internal types are deliberately opaque, so we
 * walk the structure with `unknown`-typed property reads to avoid `as`
 * casts.
 */
function readSamplingWindowMs(result: TraceResult): number {
  const range = readPath(result.parsedTrace, [
    'data',
    'Meta',
    'traceBounds',
    'range',
  ]);
  if (typeof range !== 'number' || !Number.isFinite(range)) {
    return 0;
  }
  return Math.round(range / 1000);
}

/**
 * Pluck LCP / CLS / INP numbers from the first insightSet, if any. We
 * cannot import the DevTools insight types without bringing the heavy
 * trace engine into our public API, so we read with `unknown`.
 */
function readCoreMetrics(result: TraceResult): CoreMetrics {
  const insights = result.insights;
  if (!insights) {
    return {};
  }
  const first: unknown = insights.values().next().value;
  const out: CoreMetrics = {};

  const lcp = readNumber(first, ['model', 'LCPBreakdown', 'lcpMs']);
  if (lcp !== undefined) {
    out.lcpMs = lcp;
  }
  const inp = readNumber(first, ['model', 'INPBreakdown', 'inpMs']);
  if (inp !== undefined) {
    out.inpMs = inp;
  }
  const cls = readNumber(first, ['model', 'CLSCulprits', 'clsScore']);
  if (cls !== undefined) {
    out.clsScore = cls;
  }
  return out;
}

function readPath(root: unknown, keys: readonly string[]): unknown {
  let cur: unknown = root;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') {
      return undefined;
    }
    cur = Reflect.get(cur, k);
  }
  return cur;
}

function readNumber(
  root: unknown,
  keys: readonly string[],
): number | undefined {
  const v = readPath(root, keys);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Build the summary for a successful TraceResult.
 */
export function summarizeTrace(
  buffer: Uint8Array,
  result: TraceResult,
): TraceSummary {
  return {
    events: countEvents(buffer),
    samplingWindowMs: readSamplingWindowMs(result),
    coreMetrics: readCoreMetrics(result),
  };
}

/**
 * Build a minimal summary when the trace failed to parse but the buffer
 * still exists. samplingWindowMs / coreMetrics are best-effort (0 / {}).
 */
export function summarizeRawBuffer(buffer: Uint8Array): TraceSummary {
  return {
    events: countEvents(buffer),
    samplingWindowMs: 0,
    coreMetrics: {},
  };
}
