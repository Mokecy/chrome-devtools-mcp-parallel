#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Parallel-mode bin entrypoint.
 * Implements T023: CLI parse → createParallelMcpServer → stdio.
 */

process.title = 'chrome-devtools-mcp-parallel';

import {version} from 'node:process';

const [major, minor] = version.substring(1).split('.').map(Number);

if (major === 20 && minor < 19) {
  console.error(
    `ERROR: \`chrome-devtools-mcp-parallel\` does not support Node ${process.version}. Please upgrade to Node 20.19.0 LTS or a newer LTS.`,
  );
  process.exit(1);
}

if (major === 22 && minor < 12) {
  console.error(
    `ERROR: \`chrome-devtools-mcp-parallel\` does not support Node ${process.version}. Please upgrade to Node 22.12.0 LTS or a newer LTS.`,
  );
  process.exit(1);
}

if (major < 20) {
  console.error(
    `ERROR: \`chrome-devtools-mcp-parallel\` does not support Node ${process.version}. Please upgrade to Node 20.19.0 LTS or a newer LTS.`,
  );
  process.exit(1);
}

import {parseParallelArguments} from '../parallel/cli.js';
import {createParallelMcpServer} from '../parallel/index.js';
import {VERSION} from '../version.js';

async function main() {
  const args = parseParallelArguments(VERSION);
  const handle = await createParallelMcpServer(args);

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = async () => {
    await handle.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
