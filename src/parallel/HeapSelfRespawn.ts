/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Heap self-respawn (T058 / FR-019).
 *
 * The MCP server is typically launched by an editor / agent runner that
 * does NOT pass `--max-old-space-size`, so V8 boots with the default
 * ~1.5 GB cap. Long-session work (T030 traces, big DOM snapshots) blows
 * past that. To make the safe heap default invisible to the user, the
 * bin entry checks the live heap limit at start; if it's below the
 * resolved desired size, it re-execs itself as a child process with the
 * proper `NODE_OPTIONS`, then exits with the child's status code.
 *
 * One-shot: a `CDM_HEAP_RESPAWNED=1` env var marks the child so we
 * never recurse.
 */

import {spawn} from 'node:child_process';
import type {EventEmitter} from 'node:events';
import os from 'node:os';
import v8 from 'node:v8';

import {
  applyPhysicalMemorySafety,
  resolveHeapSize,
} from './HeapSizeResolver.js';

/**
 * Minimal interface we need from a spawned child — just the EventEmitter
 * surface for `exit` / `error`. Allows tests to stub with a plain
 * `EventEmitter` without satisfying the full `ChildProcess` type.
 */
type ChildLike = Pick<EventEmitter, 'on'>;

/** Test-friendly spawn signature. Production code uses `node:child_process.spawn`. */
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {env?: NodeJS.ProcessEnv; stdio?: 'inherit'},
) => ChildLike;

const RESPAWN_FLAG_ENV = 'CDM_HEAP_RESPAWNED';
const NODE_OPTIONS_ENV = 'NODE_OPTIONS';

export interface SelfRespawnInputs {
  /** Resolved CLI `--heap-size`, may be undefined. */
  cliHeapSizeMb?: number | string;
  /** Live env (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Live argv (defaults to `process.argv`). */
  argv?: readonly string[];
  /** Test seam: live heap stats. */
  heapStatisticsFn?: () => {heap_size_limit: number};
  /** Test seam: total physical memory in MB. */
  totalMemMbFn?: () => number;
  /** Test seam: child spawner. */
  spawnFn?: SpawnFn;
  /** Test seam: process exit. */
  exitFn?: (code: number) => never;
}

export interface SelfRespawnResult {
  /**
   * `'continue'` means the current process has the right heap; carry on.
   * `'respawned'` means a child has been spawned and the caller MUST not
   * proceed (the entry function calls `exitFn` itself in production, so
   * the return is mostly informational for tests).
   */
  outcome: 'continue' | 'respawned' | 'already-child';
  /** Resolved heap target in MB. */
  desiredHeapMb: number;
  /** Where the heap value came from. */
  source: 'cli' | 'env' | 'default';
  /** Live heap_size_limit before any action. */
  observedHeapMb: number;
  /** True iff we clamped down due to physical-memory safety. */
  clampedFromMb: number | null;
}

/**
 * Inspect the live process and respawn ourselves with the desired heap
 * if needed. Returns the resolution outcome — production callers can
 * ignore the return because `exitFn` will have terminated this process.
 */
export function ensureHeapHeadroom(
  inputs: SelfRespawnInputs = {},
): SelfRespawnResult {
  const env = inputs.env ?? process.env;
  const argv = inputs.argv ?? process.argv;
  const heapStatisticsFn =
    inputs.heapStatisticsFn ?? (() => v8.getHeapStatistics());
  const totalMemMbFn =
    inputs.totalMemMbFn ?? (() => Math.floor(os.totalmem() / (1024 * 1024)));
  const productionSpawn: SpawnFn = (command, args, options) =>
    spawn(command, [...args], options);
  const spawnFn = inputs.spawnFn ?? productionSpawn;
  const exitFn =
    inputs.exitFn ??
    ((code: number): never => {
      process.exit(code);
    });

  const resolved = resolveHeapSize({
    cliHeapSizeMb: inputs.cliHeapSizeMb,
    env,
  });

  const totalMemMb = totalMemMbFn();
  const safety = applyPhysicalMemorySafety(resolved.heapSizeMb, totalMemMb);
  const desiredHeapMb = safety.heapMb;
  if (safety.clampedFromMb !== null) {
    process.stderr.write(
      `[HeapSelfRespawn] requested heap ${safety.clampedFromMb}MB exceeds physical-memory safety ratio; clamping to ${desiredHeapMb}MB (total=${totalMemMb}MB)\n`,
    );
  }

  const observedHeapBytes = heapStatisticsFn().heap_size_limit;
  const observedHeapMb = Math.floor(observedHeapBytes / (1024 * 1024));

  const baseResult = {
    desiredHeapMb,
    source: resolved.source,
    observedHeapMb,
    clampedFromMb: safety.clampedFromMb,
  };

  // Don't recurse — once is enough. The supervisor only matters on the
  // initial cold boot; a child started for any other reason must run as-is.
  if (env[RESPAWN_FLAG_ENV] === '1') {
    return {outcome: 'already-child', ...baseResult};
  }

  // Already big enough — leave the process alone. We use a small slack
  // (5% or 64MB whichever larger) to avoid bouncing around boundary
  // measurements (V8 reports slightly less than the configured value).
  const slackMb = Math.max(64, Math.floor(desiredHeapMb * 0.05));
  if (observedHeapMb >= desiredHeapMb - slackMb) {
    return {outcome: 'continue', ...baseResult};
  }

  // Compose NODE_OPTIONS — preserve any user-provided flags and append
  // ours. Prepend our value so a later duplicate (defensive) wins.
  const existingNodeOptions = env[NODE_OPTIONS_ENV] ?? '';
  const ourFlag = `--max-old-space-size=${desiredHeapMb}`;
  const newNodeOptions = existingNodeOptions
    ? `${ourFlag} ${existingNodeOptions}`
    : ourFlag;

  process.stderr.write(
    `[HeapSelfRespawn] heap_size_limit=${observedHeapMb}MB < desired=${desiredHeapMb}MB (source=${resolved.source}); respawning self with ${ourFlag}\n`,
  );

  const child = spawnFn(process.execPath, argv.slice(1), {
    stdio: 'inherit',
    env: {
      ...env,
      [RESPAWN_FLAG_ENV]: '1',
      [NODE_OPTIONS_ENV]: newNodeOptions,
    },
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      // Mirror the signal in the parent's exit code (128 + signum
      // convention is Bash-flavoured; for cross-platform we just use 1).
      exitFn(1);
      return;
    }
    exitFn(code ?? 0);
  });

  child.on('error', err => {
    process.stderr.write(
      `[HeapSelfRespawn] failed to spawn child: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitFn(1);
  });

  return {outcome: 'respawned', ...baseResult};
}
