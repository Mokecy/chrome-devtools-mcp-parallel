/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * CLI parser for chrome-devtools-mcp-parallel.
 * Reuses upstream cliOptions definitions + adds parallel-specific flags.
 * See specs/001-parallel-instances/tasks.md T011.
 */

import {cliOptions} from '../bin/chrome-devtools-mcp-cli-options.js';
import type {YargsOptions} from '../third_party/index.js';
import {yargs, hideBin} from '../third_party/index.js';

import type {ParallelServerArgs} from './types.js';

/**
 * Parallel-specific CLI options appended to upstream options.
 */
const parallelOptions = {
  maxInstances: {
    type: 'number',
    description:
      'Maximum number of parallel browser instances allowed. Default 10.',
    default: 10,
  },
  autoLaunch: {
    type: 'boolean',
    description:
      'Whether to auto-launch a Chrome debug instance when no debug port detected. Use --no-auto-launch to disable.',
    default: true,
  },

  // ---- Stability hardening: buffer / log management (FR-001..005) ----
  consoleBufferSize: {
    type: 'number',
    description:
      'Per-page console message buffer cap (env CDM_CONSOLE_BUFFER_SIZE, default 500).',
  },
  networkBufferSize: {
    type: 'number',
    description:
      'Per-page network request buffer cap (env CDM_NETWORK_BUFFER_SIZE, default 1000).',
  },
  recordSizeCapKb: {
    type: 'number',
    description:
      'Single buffered record size cap in KB; oversize records are truncated (env CDM_RECORD_SIZE_CAP_KB, default 256).',
  },

  // ---- Stability hardening: artifacts / response (FR-006..011a) ----
  artifactDir: {
    type: 'string',
    description:
      'Persistent artifact directory; if unset, an ephemeral dir under tmpdir is used and auto-cleaned on exit (env CDM_ARTIFACT_DIR).',
  },
  maxResponseSizeMb: {
    type: 'number',
    description:
      'Per-tool response size cap in MB; larger responses are written to disk and replaced with a path (env CDM_MAX_RESPONSE_SIZE_MB, default 2).',
  },
  inlinePayloadMaxMb: {
    type: 'number',
    description:
      'Maximum inline payload size in MB for screenshots/binary data when the caller opts into inline (env CDM_INLINE_PAYLOAD_MAX_MB, default 1).',
  },

  // ---- Stability hardening: self-heal (FR-012..018) ----
  reconnectMaxAttempts: {
    type: 'number',
    description:
      'Maximum CDP reconnect attempts per disconnect event (env CDM_RECONNECT_MAX_ATTEMPTS, default 3).',
  },
  reconnectBackoffMs: {
    type: 'number',
    description:
      'Initial reconnect backoff in ms; doubles each attempt (env CDM_RECONNECT_BACKOFF_MS, default 1000).',
  },
  circuitBreakAfter: {
    type: 'number',
    description:
      'Number of consecutive failed reconnect cycles before declaring an instance permanently dead (env CDM_CIRCUIT_BREAK_AFTER, default 3).',
  },

  // ---- Stability hardening: heap / memory (FR-019..023) ----
  heapSize: {
    type: 'number',
    description:
      'Desired V8 old-space heap cap in MB; bin entry will respawn under --max-old-space-size if current limit is below this (env CDM_HEAP_SIZE_MB, default 4096).',
  },
  memWarnPct: {
    type: 'number',
    description:
      'Heap utilization percentage that triggers a warning log (env CDM_MEM_WARN_PCT, default 80).',
  },
  memDangerPct: {
    type: 'number',
    description:
      'Heap utilization percentage that triggers active resource release (env CDM_MEM_DANGER_PCT, default 95).',
  },
  memSampleIntervalSec: {
    type: 'number',
    description:
      'Memory sampling interval in seconds (env CDM_MEM_SAMPLE_INTERVAL_SEC, default 60).',
  },
  systemObserveIntervalSec: {
    type: 'number',
    description:
      'Periodic stderr observability log interval in seconds. 0 disables (env CDM_SYSTEM_OBSERVE_INTERVAL_SEC, default 0).',
  },
} satisfies Record<string, YargsOptions>;

/**
 * Resolve a numeric option with the precedence:
 *   CLI flag > environment variable > built-in default.
 * Returns the default when neither CLI nor env supplies a finite number.
 */
function resolveNumberOption(
  cliValue: number | undefined,
  envValue: string | undefined,
  defaultValue: number,
): number {
  if (typeof cliValue === 'number' && Number.isFinite(cliValue)) {
    return cliValue;
  }
  if (envValue !== undefined && envValue !== '') {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return defaultValue;
}

function resolveStringOption(
  cliValue: string | undefined,
  envValue: string | undefined,
): string | undefined {
  if (typeof cliValue === 'string' && cliValue.length > 0) {
    return cliValue;
  }
  if (envValue !== undefined && envValue !== '') {
    return envValue;
  }
  return undefined;
}

/** Defaults for stability hardening options (FR mapping in tasks.md §5). */
export const STABILITY_DEFAULTS = {
  consoleBufferSize: 500,
  networkBufferSize: 1000,
  recordSizeCapKb: 256,
  maxResponseSizeMb: 2,
  inlinePayloadMaxMb: 1,
  reconnectMaxAttempts: 3,
  reconnectBackoffMs: 1000,
  circuitBreakAfter: 3,
  heapSize: 4096,
  memWarnPct: 80,
  memDangerPct: 95,
  memSampleIntervalSec: 60,
  systemObserveIntervalSec: 0,
} as const;

/**
 * Parse CLI arguments for parallel mode.
 * Returns an object conforming to ParallelServerArgs interface.
 */
export function parseParallelArguments(
  version: string,
  argv = process.argv,
  env = process.env,
): ParallelServerArgs {
  const allOptions = {...cliOptions, ...parallelOptions};

  // Pre-parse argv to reconstruct chrome-arg values verbatim. yargs splits
  // array options on commas which breaks `--chrome-arg=--disable-features=A,B`.
  // We extract the raw values here and inject them after parsing.
  const rawChromeArgs: string[] = [];
  const rawIgnoreArgs: string[] = [];
  const cleanedArgv: string[] = [];
  const argvNoBin = hideBin(argv);
  for (let i = 0; i < argvNoBin.length; i++) {
    const a = argvNoBin[i];
    const captureInto = (target: string[], rest: string | undefined) => {
      if (rest !== undefined) {
        target.push(rest);
      } else if (i + 1 < argvNoBin.length) {
        target.push(argvNoBin[++i]);
      }
    };
    if (a === '--chrome-arg' || a.startsWith('--chrome-arg=')) {
      captureInto(
        rawChromeArgs,
        a.startsWith('--chrome-arg=')
          ? a.slice('--chrome-arg='.length)
          : undefined,
      );
      continue;
    }
    if (
      a === '--ignore-default-chrome-arg' ||
      a.startsWith('--ignore-default-chrome-arg=')
    ) {
      captureInto(
        rawIgnoreArgs,
        a.startsWith('--ignore-default-chrome-arg=')
          ? a.slice('--ignore-default-chrome-arg='.length)
          : undefined,
      );
      continue;
    }
    cleanedArgv.push(a);
  }

  const parsed = yargs(cleanedArgv)
    .scriptName('npx chrome-devtools-mcp-parallel@latest')
    .options(allOptions)
    .check(args => {
      // Inherit upstream channel default logic
      if (
        !args.channel &&
        !args.browserUrl &&
        !args.wsEndpoint &&
        !args.executablePath
      ) {
        args.channel = 'stable';
      }
      if (env['CI'] || env['CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS']) {
        args.usageStatistics = false;
      }
      // Validate maxInstances
      if (
        typeof args.maxInstances === 'number' &&
        (args.maxInstances < 1 || args.maxInstances > 100)
      ) {
        throw new Error('--max-instances must be between 1 and 100.');
      }
      return true;
    })
    .example([
      ['$0', 'Start parallel MCP server (auto-launch Chrome if needed)'],
      ['$0 --max-instances 5', 'Limit to 5 parallel instances'],
      [
        '$0 --no-auto-launch',
        'Disable automatic Chrome launch; require manual browser_connect',
      ],
      ['$0 --headless --max-instances 3', 'Run headless with max 3 instances'],
    ])
    .version(version)
    .help()
    .strict()
    .parseSync();

  // Inject preserved chrome-arg / ignore-default-chrome-arg values, replacing
  // anything yargs put there (which may have been comma-split).
  const finalArgs: ParallelServerArgs = {
    ...parsed,
    maxInstances: (parsed.maxInstances ?? 10) satisfies number,
    autoLaunch: (parsed.autoLaunch ?? true) satisfies boolean,
    consoleBufferSize: resolveNumberOption(
      parsed.consoleBufferSize,
      env['CDM_CONSOLE_BUFFER_SIZE'],
      STABILITY_DEFAULTS.consoleBufferSize,
    ),
    networkBufferSize: resolveNumberOption(
      parsed.networkBufferSize,
      env['CDM_NETWORK_BUFFER_SIZE'],
      STABILITY_DEFAULTS.networkBufferSize,
    ),
    recordSizeCapKb: resolveNumberOption(
      parsed.recordSizeCapKb,
      env['CDM_RECORD_SIZE_CAP_KB'],
      STABILITY_DEFAULTS.recordSizeCapKb,
    ),
    artifactDir: resolveStringOption(
      parsed.artifactDir,
      env['CDM_ARTIFACT_DIR'],
    ),
    maxResponseSizeMb: resolveNumberOption(
      parsed.maxResponseSizeMb,
      env['CDM_MAX_RESPONSE_SIZE_MB'],
      STABILITY_DEFAULTS.maxResponseSizeMb,
    ),
    inlinePayloadMaxMb: resolveNumberOption(
      parsed.inlinePayloadMaxMb,
      env['CDM_INLINE_PAYLOAD_MAX_MB'],
      STABILITY_DEFAULTS.inlinePayloadMaxMb,
    ),
    reconnectMaxAttempts: resolveNumberOption(
      parsed.reconnectMaxAttempts,
      env['CDM_RECONNECT_MAX_ATTEMPTS'],
      STABILITY_DEFAULTS.reconnectMaxAttempts,
    ),
    reconnectBackoffMs: resolveNumberOption(
      parsed.reconnectBackoffMs,
      env['CDM_RECONNECT_BACKOFF_MS'],
      STABILITY_DEFAULTS.reconnectBackoffMs,
    ),
    circuitBreakAfter: resolveNumberOption(
      parsed.circuitBreakAfter,
      env['CDM_CIRCUIT_BREAK_AFTER'],
      STABILITY_DEFAULTS.circuitBreakAfter,
    ),
    heapSize: resolveNumberOption(
      parsed.heapSize,
      env['CDM_HEAP_SIZE_MB'],
      STABILITY_DEFAULTS.heapSize,
    ),
    memWarnPct: resolveNumberOption(
      parsed.memWarnPct,
      env['CDM_MEM_WARN_PCT'],
      STABILITY_DEFAULTS.memWarnPct,
    ),
    memDangerPct: resolveNumberOption(
      parsed.memDangerPct,
      env['CDM_MEM_DANGER_PCT'],
      STABILITY_DEFAULTS.memDangerPct,
    ),
    memSampleIntervalSec: resolveNumberOption(
      parsed.memSampleIntervalSec,
      env['CDM_MEM_SAMPLE_INTERVAL_SEC'],
      STABILITY_DEFAULTS.memSampleIntervalSec,
    ),
    systemObserveIntervalSec: resolveNumberOption(
      parsed.systemObserveIntervalSec,
      env['CDM_SYSTEM_OBSERVE_INTERVAL_SEC'],
      STABILITY_DEFAULTS.systemObserveIntervalSec,
    ),
  } satisfies ParallelServerArgs;
  if (rawChromeArgs.length > 0) {
    finalArgs.chromeArg = rawChromeArgs;
  }
  if (rawIgnoreArgs.length > 0) {
    finalArgs.ignoreDefaultChromeArg = rawIgnoreArgs;
  }
  return finalArgs;
}
