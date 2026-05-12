/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * MemoryMonitor (T066 / FR-022).
 *
 * Periodic sampler that watches V8 heap utilisation and:
 *   - emits a `[MemoryMonitor][WARN]` line to stderr when usage crosses
 *     the warn threshold (default 80%)
 *   - calls a caller-supplied `onDanger` callback when usage crosses the
 *     danger threshold (default 95%); the parallel server uses this to
 *     close idle instances (FR-022)
 *   - retains the last 60 samples in a ring buffer for `CrashLogger` and
 *     observability tools to introspect
 *
 * Public methods are sync; the sampling tick is fire-and-forget so the
 * timer never accumulates back-pressure.
 */

import v8 from 'node:v8';

import {logger} from '../logger.js';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WARN_PCT = 80;
const DEFAULT_DANGER_PCT = 95;
const RING_CAPACITY = 60;

export interface MemorySample {
  /** Wall clock — ISO string for log readability + ms epoch for math. */
  readonly atIso: string;
  readonly atMs: number;
  /** RSS in bytes — process-wide memory footprint. */
  readonly rss: number;
  /** Used heap in bytes. */
  readonly heapUsed: number;
  /** V8 heap upper limit (`heap_size_limit`) in bytes. */
  readonly heapLimit: number;
  /** Heap utilisation percentage 0..100 (rounded to 2 decimals). */
  readonly heapPct: number;
}

export interface MemoryMonitorOptions {
  /** Sampling interval in ms. Default 60_000. */
  intervalMs?: number;
  /** Warn threshold percentage (0..100). Default 80. */
  warnPct?: number;
  /** Danger threshold percentage (0..100). Default 95. */
  dangerPct?: number;
  /** Ring buffer capacity. Default 60 samples (= 1 hour @ 60s). */
  ringCapacity?: number;
  /**
   * Called on every danger-level sample. Async-safe — errors are caught
   * and logged. Typical implementation: close idle instances.
   */
  onDanger?: (sample: MemorySample) => void | Promise<void>;
  /**
   * Called on every warn-level sample (post the stderr emission). Useful
   * for tests / observability.
   */
  onWarn?: (sample: MemorySample) => void;
  /** Test seam: inject `process.memoryUsage`. */
  memoryUsageFn?: () => NodeJS.MemoryUsage;
  /** Test seam: inject `v8.getHeapStatistics`. */
  heapStatisticsFn?: () => {heap_size_limit: number};
}

export class MemoryMonitor {
  readonly #intervalMs: number;
  readonly #warnPct: number;
  readonly #dangerPct: number;
  readonly #ringCapacity: number;
  readonly #onDanger:
    | ((sample: MemorySample) => void | Promise<void>)
    | undefined;
  readonly #onWarn: ((sample: MemorySample) => void) | undefined;
  readonly #memoryUsageFn: () => NodeJS.MemoryUsage;
  readonly #heapStatisticsFn: () => {heap_size_limit: number};
  readonly #ring: MemorySample[] = [];

  #timer: ReturnType<typeof setInterval> | null = null;
  #lastSeverity: 'ok' | 'warn' | 'danger' = 'ok';

  constructor(options: MemoryMonitorOptions = {}) {
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#warnPct = options.warnPct ?? DEFAULT_WARN_PCT;
    this.#dangerPct = options.dangerPct ?? DEFAULT_DANGER_PCT;
    this.#ringCapacity = options.ringCapacity ?? RING_CAPACITY;
    this.#onDanger = options.onDanger;
    this.#onWarn = options.onWarn;
    this.#memoryUsageFn =
      options.memoryUsageFn ?? (() => process.memoryUsage());
    this.#heapStatisticsFn =
      options.heapStatisticsFn ?? (() => v8.getHeapStatistics());
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    // Don't keep the event loop alive solely on the sampler.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Snapshot the recent ring buffer. Returns a defensive copy. Newest
   * entry is last.
   */
  recentSamples(): readonly MemorySample[] {
    return [...this.#ring];
  }

  /** Force one sampling cycle. Public so tests + observability can poll on demand. */
  async tick(): Promise<MemorySample> {
    const mu = this.#memoryUsageFn();
    const stats = this.#heapStatisticsFn();
    const limit = stats.heap_size_limit > 0 ? stats.heap_size_limit : 1;
    const pct = Math.round((mu.heapUsed / limit) * 10000) / 100;
    const now = Date.now();
    const sample: MemorySample = {
      atIso: new Date(now).toISOString(),
      atMs: now,
      rss: mu.rss,
      heapUsed: mu.heapUsed,
      heapLimit: limit,
      heapPct: pct,
    };
    this.#pushRing(sample);

    let severity: 'ok' | 'warn' | 'danger' = 'ok';
    if (pct >= this.#dangerPct) {
      severity = 'danger';
    } else if (pct >= this.#warnPct) {
      severity = 'warn';
    }

    // Edge-trigger: only emit when severity rises (or re-emits the same
    // danger band — danger SHOULD keep firing onDanger every tick).
    if (severity === 'warn' && this.#lastSeverity !== 'warn') {
      this.#emitWarn(sample);
    } else if (severity === 'danger') {
      // Always re-fire on danger so close-idle keeps reclaiming.
      this.#emitDanger(sample);
    }
    this.#lastSeverity = severity;

    return sample;
  }

  #pushRing(sample: MemorySample): void {
    this.#ring.push(sample);
    while (this.#ring.length > this.#ringCapacity) {
      this.#ring.shift();
    }
  }

  #emitWarn(sample: MemorySample): void {
    process.stderr.write(
      `[MemoryMonitor][WARN] heap ${sample.heapPct}% (used=${formatMb(sample.heapUsed)} / limit=${formatMb(sample.heapLimit)}, rss=${formatMb(sample.rss)}) at ${sample.atIso}\n`,
    );
    // Best-effort GC hint for sessions launched with --expose-gc.
    maybeGc();
    if (this.#onWarn) {
      try {
        this.#onWarn(sample);
      } catch (err) {
        logger(
          `MemoryMonitor onWarn handler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  #emitDanger(sample: MemorySample): void {
    process.stderr.write(
      `[MemoryMonitor][DANGER] heap ${sample.heapPct}% — closing idle resources at ${sample.atIso}\n`,
    );
    if (this.#onDanger) {
      try {
        const ret = this.#onDanger(sample);
        if (isPromiseLike(ret)) {
          ret.then(
            () => undefined,
            err => {
              logger(
                `MemoryMonitor onDanger handler rejected: ${err instanceof Error ? err.message : String(err)}`,
              );
            },
          );
        }
      } catch (err) {
        logger(
          `MemoryMonitor onDanger handler threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== 'object') {
    return false;
  }
  const candidate: {then?: unknown} = value;
  return typeof candidate.then === 'function';
}

function maybeGc(): void {
  const g: {gc?: unknown} = globalThis;
  if (typeof g.gc === 'function') {
    try {
      g.gc();
    } catch {
      /* swallow */
    }
  }
}
