/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T063 — CrashLogger unit tests.
 *
 * We never raise a real `uncaughtException` from the test (would crash
 * the runner). Instead we exercise the public `writeCrash` method with
 * representative payloads and assert the on-disk artifact shape, plus
 * the install/uninstall lifecycle on the process listener list.
 */

import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {CrashLogger} from '../../src/parallel/CrashLogger.js';

interface CrashLogShape {
  ts: string;
  kind: string;
  error: {message: string; stack: string | null; name: string | null};
  activeInstances: unknown;
  memorySamples: unknown;
  recentToolCalls: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return {...value};
  }
  return {};
}

function parseCrashLog(raw: string): CrashLogShape {
  const o = asRecord(JSON.parse(raw));
  const errObj = asRecord(o['error']);
  return {
    ts: String(o['ts'] ?? ''),
    kind: String(o['kind'] ?? ''),
    error: {
      message: String(errObj['message'] ?? ''),
      stack: null,
      name: null,
    },
    activeInstances: o['activeInstances'],
    memorySamples: o['memorySamples'],
    recentToolCalls: o['recentToolCalls'],
  };
}

function asCollectorError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const r: Record<string, unknown> = {...value};
  const v = r['collectorError'];
  return typeof v === 'string' ? v : undefined;
}

describe('CrashLogger (T063)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'crashlogger-test-'));
  });
  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
  });

  it('writes a crash log with all collector outputs', () => {
    const logger = new CrashLogger({
      artifactDir: dir,
      collectActiveInstances: () => [{id: 'a', state: 'dead'}],
      collectMemorySamples: () => [{heapPct: 99.5}],
      collectRecentToolCalls: () => [{tool: 'page_navigate_page', ok: false}],
      exitPolicy: 'noop',
    });

    const filePath = logger.writeCrash(
      'uncaughtException',
      new Error('boom — heap OOM'),
    );
    assert.ok(filePath, 'writeCrash should return a path');
    assert.ok(statSync(filePath).size > 0);

    const parsed = parseCrashLog(readFileSync(filePath, 'utf8'));
    assert.equal(parsed.kind, 'uncaughtException');
    assert.equal(parsed.error.message, 'boom — heap OOM');
    assert.deepEqual(parsed.activeInstances, [{id: 'a', state: 'dead'}]);
    assert.deepEqual(parsed.memorySamples, [{heapPct: 99.5}]);
    assert.deepEqual(parsed.recentToolCalls, [
      {tool: 'page_navigate_page', ok: false},
    ]);
  });

  it('survives a collector that throws — keeps the log writable', () => {
    const logger = new CrashLogger({
      artifactDir: dir,
      collectActiveInstances: () => {
        throw new Error('snapshotHealth fail');
      },
      exitPolicy: 'noop',
    });
    const filePath = logger.writeCrash('unhandledRejection', new Error('x'));
    assert.ok(filePath);
    const parsed = parseCrashLog(readFileSync(filePath, 'utf8'));
    assert.equal(
      asCollectorError(parsed.activeInstances),
      'snapshotHealth fail',
    );
  });

  it('install() registers process listeners, uninstall() removes them', () => {
    const before = process.listenerCount('uncaughtException');
    const logger = new CrashLogger({artifactDir: dir, exitPolicy: 'noop'});
    logger.install();
    assert.equal(
      process.listenerCount('uncaughtException'),
      before + 1,
      'install should add one listener',
    );
    logger.uninstall();
    assert.equal(
      process.listenerCount('uncaughtException'),
      before,
      'uninstall should remove the listener',
    );
  });

  it('install() is idempotent', () => {
    const before = process.listenerCount('uncaughtException');
    const logger = new CrashLogger({artifactDir: dir, exitPolicy: 'noop'});
    logger.install();
    logger.install();
    assert.equal(process.listenerCount('uncaughtException'), before + 1);
    logger.uninstall();
  });

  it('crashesDir is `<artifactDir>/crashes`', () => {
    const logger = new CrashLogger({artifactDir: dir, exitPolicy: 'noop'});
    assert.equal(logger.crashesDir, path.join(dir, 'crashes'));
  });
});
