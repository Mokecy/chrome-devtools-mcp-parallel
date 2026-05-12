/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Heap size precedence resolver (T065 / FR-020).
 *
 * Pure function — no side effects, no env lookups via process.env beyond
 * what the caller passes in. Keep it deterministic so the unit test can
 * pin every branch.
 *
 *   precedence: CLI flag (`--heap-size`) > env (`CDM_HEAP_SIZE_MB`) > default
 *
 * The default is the WP-4 safe floor of 4096 MB. CLI values <= 0 are
 * treated as "unset" so users can pass an empty placeholder without
 * silently wiping the default. Same for non-numeric env values.
 *
 * Physical memory safety check (FR-021) lives separately in
 * `applyPhysicalMemorySafety` so the precedence logic stays trivially
 * testable.
 */

export const DEFAULT_HEAP_SIZE_MB = 4096;
const ENV_VAR = 'CDM_HEAP_SIZE_MB';

export interface HeapSizeInputs {
  /** Parsed `--heap-size` CLI value. `undefined` when not specified. */
  cliHeapSizeMb?: number | string;
  /** `process.env` snapshot. Caller passes the live object. */
  env?: NodeJS.ProcessEnv;
  /** Override default (used by tests). Defaults to 4096. */
  defaultMb?: number;
}

export interface HeapSizeResolution {
  /** Final resolved heap size in MB. */
  heapSizeMb: number;
  /** Where the value came from — useful for boot-time logging. */
  source: 'cli' | 'env' | 'default';
}

/**
 * Resolve the desired Node `--max-old-space-size` value from layered
 * configuration sources.
 */
export function resolveHeapSize(
  inputs: HeapSizeInputs = {},
): HeapSizeResolution {
  const defaultMb = inputs.defaultMb ?? DEFAULT_HEAP_SIZE_MB;
  const cli = coerceMb(inputs.cliHeapSizeMb);
  if (cli !== undefined) {
    return {heapSizeMb: cli, source: 'cli'};
  }
  const env = coerceMb(inputs.env?.[ENV_VAR]);
  if (env !== undefined) {
    return {heapSizeMb: env, source: 'env'};
  }
  return {heapSizeMb: defaultMb, source: 'default'};
}

/**
 * Cap the resolved heap to a fraction of total physical memory (FR-021).
 * Returns the (possibly clamped) heap plus a flag describing whether
 * a clamp happened — callers should warn to stderr in that case.
 *
 * @param heapMb desired heap size in MB
 * @param totalMemMb total physical memory in MB
 * @param safetyFraction fraction of total memory the heap is allowed to use
 *        (default 0.75 — leaves a quarter for the OS, Chrome processes,
 *        the renderer pool, etc.)
 */
export function applyPhysicalMemorySafety(
  heapMb: number,
  totalMemMb: number,
  safetyFraction = 0.75,
): {heapMb: number; clampedFromMb: number | null} {
  const safeMax = Math.floor(totalMemMb * safetyFraction);
  if (heapMb > safeMax && safeMax > 0) {
    return {heapMb: safeMax, clampedFromMb: heapMb};
  }
  return {heapMb, clampedFromMb: null};
}

function coerceMb(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
}
