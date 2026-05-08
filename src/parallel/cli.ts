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
} satisfies Record<string, YargsOptions>;

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
      captureInto(rawChromeArgs, a.startsWith('--chrome-arg=') ? a.slice('--chrome-arg='.length) : undefined);
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
  } satisfies ParallelServerArgs;
  if (rawChromeArgs.length > 0) {
    finalArgs.chromeArg = rawChromeArgs;
  }
  if (rawIgnoreArgs.length > 0) {
    finalArgs.ignoreDefaultChromeArg = rawIgnoreArgs;
  }
  return finalArgs;
}
