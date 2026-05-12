/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Observability (T075 / FR-024b).
 *
 * Builds a structured runtime-state snapshot covering:
 *   - per-instance lifecycle state and console/network buffer occupancy
 *   - process-wide memory footprint (RSS, heapUsed, heapPct)
 *   - artifact directory disk usage (lazy — best-effort via `du`-like walk)
 *   - the most-recent memory samples from `MemoryMonitor`
 *
 * Two consumption modes:
 *   1. Periodic stderr emission (operator-grade observability without
 *      attaching a debugger). Disabled by default; enabled by the server
 *      entry when `args.systemObserveIntervalSec > 0`.
 *   2. On-demand JSON via the `system_observe` MCP tool — useful for
 *      health dashboards, soak tests, regression triage.
 *
 * Buffer counters are sampled from each instance's *currently selected*
 * page. Aggregating across every navigation chunk on every page would
 * either need a public API on `McpContext` we don't yet have, or pay
 * O(pages × buffer) per snapshot which dwarfs the rest of the work.
 * Selected-page numbers are still meaningful — a power user can flip
 * pages then re-snapshot.
 */

import {statSync, readdirSync} from 'node:fs';
import path from 'node:path';

import {logger} from '../logger.js';

import type {MemoryMonitor, MemorySample} from './MemoryMonitor.js';

export interface InstanceObservation {
  id: string;
  state: string;
  console: {retained: number; evicted: number};
  network: {retained: number; evicted: number};
}

export interface ObservabilitySnapshot {
  ts: string;
  instances: InstanceObservation[];
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapPct: number;
  };
  artifactDir: {
    ephemeralBytes: number;
    persistentBytes: number;
  };
  recentMemorySamples?: readonly MemorySample[];
}

/**
 * Minimum structural shape Observability needs from each instance. The
 * real `Instance` type satisfies this — but typing the dependency as a
 * narrow interface keeps the unit tests free of full McpContext mocks.
 */
export interface ObservableBufferMeta {
  total: {size: number; evicted: number};
}
export interface ObservableMcpContext {
  getSelectedMcpPage(): unknown;
  getConsoleBufferMeta(
    page: unknown,
    includePreserved?: boolean,
  ): ObservableBufferMeta;
  getNetworkBufferMeta(
    page: unknown,
    includePreserved?: boolean,
  ): ObservableBufferMeta;
}
export interface ObservableInstance {
  id: string;
  state: string;
  mcpContext: ObservableMcpContext;
}
export interface InstanceListSource {
  list(): readonly ObservableInstance[];
}

export interface ObservabilityOptions {
  registry: InstanceListSource;
  memoryMonitor: MemoryMonitor;
  /** Optional persistent artifact root (`--artifact-dir`). */
  artifactPersistentDir?: string;
  /** Optional ephemeral artifact root (per-pid tmpdir slot). */
  artifactEphemeralDir?: string;
  /**
   * Include the rolling memory ring buffer in the snapshot. Off by
   * default to keep the periodic stderr line compact; the on-demand tool
   * passes `true`.
   */
  includeMemorySamples?: boolean;
}

export class Observability {
  readonly #registry: InstanceListSource;
  readonly #memoryMonitor: MemoryMonitor;
  readonly #artifactPersistentDir: string | undefined;
  readonly #artifactEphemeralDir: string | undefined;
  #periodicTimer: ReturnType<typeof setInterval> | null = null;
  /** Cached disk-usage values to keep the periodic path cheap. */
  #cachedDirSizes: {ts: number; ephemeral: number; persistent: number} | null =
    null;

  constructor(options: ObservabilityOptions) {
    this.#registry = options.registry;
    this.#memoryMonitor = options.memoryMonitor;
    this.#artifactPersistentDir = options.artifactPersistentDir;
    this.#artifactEphemeralDir = options.artifactEphemeralDir;
  }

  /** Build a fresh snapshot. Synchronous — ok to call from periodic timer. */
  snapshot(opts: {includeMemorySamples?: boolean} = {}): ObservabilitySnapshot {
    const instances: InstanceObservation[] = [];
    for (const inst of this.#registry.list()) {
      instances.push(this.#observeInstance(inst));
    }

    // Pull the latest sample if we have one — otherwise fall back to a
    // synchronous sample so the snapshot is never blank.
    const samples = this.#memoryMonitor.recentSamples();
    const latest = samples[samples.length - 1];
    const heapMemMb = latest
      ? {
          rssMb: roundMb(latest.rss),
          heapUsedMb: roundMb(latest.heapUsed),
          heapPct: latest.heapPct,
        }
      : {rssMb: 0, heapUsedMb: 0, heapPct: 0};

    const dirSizes = this.#dirSizesCached();

    const snap: ObservabilitySnapshot = {
      ts: new Date().toISOString(),
      instances,
      memory: heapMemMb,
      artifactDir: {
        ephemeralBytes: dirSizes.ephemeral,
        persistentBytes: dirSizes.persistent,
      },
    };
    if (opts.includeMemorySamples) {
      snap.recentMemorySamples = samples;
    }
    return snap;
  }

  /**
   * Begin emitting compact JSON snapshots to stderr every `intervalMs`.
   * No-op if intervalMs <= 0. Idempotent.
   */
  startPeriodicLog(intervalMs: number): void {
    if (this.#periodicTimer) {
      return;
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    const timer = setInterval(() => {
      try {
        const snap = this.snapshot();
        process.stderr.write(`[observability] ${JSON.stringify(snap)}\n`);
      } catch (err) {
        logger(
          `Observability periodic log failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.#periodicTimer = timer;
  }

  stop(): void {
    if (this.#periodicTimer) {
      clearInterval(this.#periodicTimer);
      this.#periodicTimer = null;
    }
  }

  #observeInstance(inst: ObservableInstance): InstanceObservation {
    const obs: InstanceObservation = {
      id: inst.id,
      state: inst.state,
      console: {retained: 0, evicted: 0},
      network: {retained: 0, evicted: 0},
    };

    // Buffer meta needs a selected page. If none is selected (instance
    // just created, or all pages closed), fall through with zeros — the
    // FR-024b contract is best-effort visibility, not strict accuracy.
    try {
      const page = inst.mcpContext.getSelectedMcpPage();
      const consoleMeta = inst.mcpContext.getConsoleBufferMeta(page, false);
      const networkMeta = inst.mcpContext.getNetworkBufferMeta(page, false);
      obs.console.retained = consoleMeta.total.size;
      obs.console.evicted = consoleMeta.total.evicted;
      obs.network.retained = networkMeta.total.size;
      obs.network.evicted = networkMeta.total.evicted;
    } catch {
      // No selected page — leave zeros.
    }
    return obs;
  }

  /**
   * Disk usage is not free (recursive walk). Cache for ~10s so the
   * periodic logger stays cheap while still tracking growth on a
   * human-readable cadence.
   */
  #dirSizesCached(): {ephemeral: number; persistent: number} {
    const now = Date.now();
    if (this.#cachedDirSizes && now - this.#cachedDirSizes.ts < 10_000) {
      return {
        ephemeral: this.#cachedDirSizes.ephemeral,
        persistent: this.#cachedDirSizes.persistent,
      };
    }
    const ephemeral = this.#artifactEphemeralDir
      ? safeDirSize(this.#artifactEphemeralDir)
      : 0;
    const persistent = this.#artifactPersistentDir
      ? safeDirSize(this.#artifactPersistentDir)
      : 0;
    this.#cachedDirSizes = {ts: now, ephemeral, persistent};
    return {ephemeral, persistent};
  }
}

function roundMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Recursive size walk with a hard cap on entries visited. We don't want
 * to chew CPU on a runaway artifact dir during periodic sampling.
 */
function safeDirSize(dir: string, entryCap = 5000): number {
  let total = 0;
  let visited = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && visited < entryCap) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    let entries: ReadonlyArray<{name: string; isDirectory: () => boolean}>;
    try {
      entries = readdirSync(current, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (visited >= entryCap) {
        break;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += statSync(full).size;
        } catch {
          // file vanished mid-walk; skip
        }
      }
    }
  }
  return total;
}
