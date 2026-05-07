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

  const parsed = yargs(hideBin(argv))
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

  // Construct ParallelServerArgs from parsed values.
  // yargs guarantees defaults are filled. We access fields by name to
  // maintain type safety without `as`.
  return {
    ...parsed,
    maxInstances: (parsed.maxInstances ?? 10) satisfies number,
    autoLaunch: (parsed.autoLaunch ?? true) satisfies boolean,
  } satisfies ParallelServerArgs;
}
