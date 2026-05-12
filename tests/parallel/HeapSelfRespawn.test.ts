/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T060 — HeapSelfRespawn unit test (FR-019).
 *
 * Drives `ensureHeapHeadroom` with mocked v8 / spawn / exit / env so we
 * can assert every branch deterministically — no real child process is
 * created.
 */

import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {ensureHeapHeadroom} from '../../src/parallel/HeapSelfRespawn.js';

const MB = 1024 * 1024;

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: {env?: NodeJS.ProcessEnv};
}

function makeSpawnStub(): {
  fn: (
    command: string,
    args: readonly string[],
    options: {env?: NodeJS.ProcessEnv},
  ) => EventEmitter;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    fn: (command, args, options) => {
      calls.push({command, args, options});
      const child = new EventEmitter();
      // Test never wires `exit` from outside; tests assert state pre-exit.
      return child;
    },
  };
}

describe('ensureHeapHeadroom (T060)', () => {
  it('continues when live heap is already at/above desired', () => {
    const result = ensureHeapHeadroom({
      cliHeapSizeMb: 4096,
      env: {},
      argv: ['/x/node', '/x/cli.js'],
      heapStatisticsFn: () => ({heap_size_limit: 4096 * MB}),
      totalMemMbFn: () => 32_768,
      spawnFn: () => {
        throw new Error('should not spawn');
      },
      exitFn: () => {
        throw new Error('should not exit');
      },
    });
    assert.equal(result.outcome, 'continue');
    assert.equal(result.desiredHeapMb, 4096);
    assert.equal(result.source, 'cli');
  });

  it('respawns when live heap is below desired', () => {
    const spawnStub = makeSpawnStub();
    let exited: number | null = null;

    ensureHeapHeadroom({
      env: {},
      argv: ['/x/node', '/x/cli.js', '--foo'],
      heapStatisticsFn: () => ({heap_size_limit: 1500 * MB}),
      totalMemMbFn: () => 32_768,
      spawnFn: (cmd, args, opts) => {
        spawnStub.calls.push({command: cmd, args, options: opts});
        return new EventEmitter();
      },
      exitFn: code => {
        exited = code;
        throw new Error('exit-stub');
      },
    });

    // Spawn called with `--max-old-space-size=4096` in NODE_OPTIONS.
    assert.equal(spawnStub.calls.length, 1);
    const env = spawnStub.calls[0].options.env;
    assert.ok(env && env['NODE_OPTIONS']);
    assert.match(String(env['NODE_OPTIONS']), /--max-old-space-size=4096/);
    assert.equal(env['CDM_HEAP_RESPAWNED'], '1');
    // Argv passes through (sans node binary).
    assert.deepEqual(spawnStub.calls[0].args, ['/x/cli.js', '--foo']);
    // Exit not yet — child hasn't emitted 'exit'.
    assert.equal(exited, null);
  });

  it('skips when CDM_HEAP_RESPAWNED is already set (no recursion)', () => {
    let spawned = false;
    const result = ensureHeapHeadroom({
      cliHeapSizeMb: 8192,
      env: {CDM_HEAP_RESPAWNED: '1'},
      argv: ['/x/node', '/x/cli.js'],
      heapStatisticsFn: () => ({heap_size_limit: 1500 * MB}), // would trigger respawn
      totalMemMbFn: () => 32_768,
      spawnFn: () => {
        spawned = true;
        return new EventEmitter();
      },
      exitFn: () => {
        throw new Error('exit not expected');
      },
    });
    assert.equal(result.outcome, 'already-child');
    assert.equal(spawned, false);
  });

  it('CLI > env > default precedence (FR-020)', () => {
    const cliResult = ensureHeapHeadroom({
      cliHeapSizeMb: 8192,
      env: {CDM_HEAP_SIZE_MB: '6144'},
      heapStatisticsFn: () => ({heap_size_limit: 99_999 * MB}), // skip respawn
      totalMemMbFn: () => 32_768,
      spawnFn: () => new EventEmitter(),
      exitFn: () => {
        throw new Error('not used');
      },
    });
    assert.equal(cliResult.source, 'cli');
    assert.equal(cliResult.desiredHeapMb, 8192);

    const envResult = ensureHeapHeadroom({
      env: {CDM_HEAP_SIZE_MB: '2048'},
      heapStatisticsFn: () => ({heap_size_limit: 99_999 * MB}),
      totalMemMbFn: () => 32_768,
      spawnFn: () => new EventEmitter(),
      exitFn: () => {
        throw new Error('not used');
      },
    });
    assert.equal(envResult.source, 'env');
    assert.equal(envResult.desiredHeapMb, 2048);

    const defResult = ensureHeapHeadroom({
      env: {},
      heapStatisticsFn: () => ({heap_size_limit: 99_999 * MB}),
      totalMemMbFn: () => 32_768,
      spawnFn: () => new EventEmitter(),
      exitFn: () => {
        throw new Error('not used');
      },
    });
    assert.equal(defResult.source, 'default');
    assert.equal(defResult.desiredHeapMb, 4096);
  });

  it('clamps desired heap to physical-memory safety on tiny boxes (FR-021)', () => {
    const result = ensureHeapHeadroom({
      cliHeapSizeMb: 8192,
      env: {},
      heapStatisticsFn: () => ({heap_size_limit: 99_999 * MB}),
      // 4 GB box → safety floor = 3 GB → clamps from 8 GB.
      totalMemMbFn: () => 4096,
      spawnFn: () => new EventEmitter(),
      exitFn: () => {
        throw new Error('not used');
      },
    });
    assert.equal(result.desiredHeapMb, Math.floor(4096 * 0.75));
    assert.equal(result.clampedFromMb, 8192);
  });
});
