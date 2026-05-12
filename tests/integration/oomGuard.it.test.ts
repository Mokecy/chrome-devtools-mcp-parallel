/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T064 — OOM guard integration test (FR-023 / SC-008).
 *
 * Spawns a fresh Node process that:
 *   1. instantiates `CrashLogger` against a temp artifact dir
 *   2. installs the handlers
 *   3. throws an OOM-class error from a setImmediate so we hit the
 *      `uncaughtException` path the same way a real OOM would
 *
 * Asserts:
 *   - the child exits with a non-zero status code (FR-023)
 *   - a `<dir>/crashes/<ISO>.log` file exists with the expected shape
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

const CRASH_LOGGER_BUILT_PATH = path.resolve(
  'build/src/parallel/CrashLogger.js',
);

describe('OOM guard integration (T064)', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'oomGuard-it-'));
  });
  after(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('writes a crash log and exits non-zero on uncaughtException', () => {
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
        import('${pathToFileUrl(CRASH_LOGGER_BUILT_PATH)}').then(({CrashLogger}) => {
          const logger = new CrashLogger({
            artifactDir: ${JSON.stringify(dir)},
            collectActiveInstances: () => [{id: 'oom-1', state: 'reconnecting'}],
            collectMemorySamples: () => [{heapPct: 96}],
            collectRecentToolCalls: () => [{tool: 'page_take_snapshot', ok: false}],
          });
          logger.install();
          // Throw asynchronously so the uncaughtException handler is the
          // sole observer (a sync throw in the dynamic import callback
          // would propagate up to Node's import error handling which is
          // a different path).
          setImmediate(() => {
            const err = new Error('JavaScript heap out of memory');
            err.name = 'RangeError';
            throw err;
          });
        });
        `,
      ],
      {
        env: {...process.env, NODE_OPTIONS: ''},
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    assert.notEqual(child.status, 0, 'child should exit non-zero');
    // stderr should contain the breadcrumb the logger writes.
    assert.match(child.stderr ?? '', /\[CrashLogger\] wrote/);

    // A crash log file should exist.
    const crashesDir = path.join(dir, 'crashes');
    const files = readdirSync(crashesDir);
    assert.ok(files.length >= 1, `expected a crash log in ${crashesDir}`);
    const filePath = path.join(crashesDir, files[0]);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));

    if (typeof parsed !== 'object' || parsed === null) {
      assert.fail('crash log is not a JSON object');
      return;
    }
    const record: Record<string, unknown> = {...parsed};

    assert.equal(record['kind'], 'uncaughtException');

    const errObj =
      record['error'] && typeof record['error'] === 'object'
        ? {...record['error']}
        : {};
    const errRecord: Record<string, unknown> = errObj;
    assert.equal(errRecord['message'], 'JavaScript heap out of memory');

    assert.deepEqual(record['activeInstances'], [
      {id: 'oom-1', state: 'reconnecting'},
    ]);
    assert.deepEqual(record['memorySamples'], [{heapPct: 96}]);
    assert.deepEqual(record['recentToolCalls'], [
      {tool: 'page_take_snapshot', ok: false},
    ]);
  });
});

function pathToFileUrl(absPath: string): string {
  // Manual conversion to avoid pulling in `url` module just for this test.
  // Windows paths need the leading slash + forward slashes.
  const normalised = absPath.replace(/\\/g, '/');
  return normalised.startsWith('/')
    ? `file://${normalised}`
    : `file:///${normalised}`;
}
