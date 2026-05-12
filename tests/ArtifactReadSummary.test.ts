/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for T029: page_artifact_read_summary management tool.
 */

import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

import {artifactReadSummary} from '../src/parallel/managementTools/artifactReadSummary.js';

interface SC {
  kind?: string;
  filePath?: string;
  sizeBytes?: number;
  topNodeKinds?: Array<{kind: string; count: number}>;
  summary?: {
    events?: number;
    samplingWindowMs?: number;
    coreMetrics?: Record<string, number>;
  };
  topLevelKeys?: string[];
  slice?: {start: number; end: number; text: string};
  // StructuredError envelope when isError
  code?: string;
  recoverable?: boolean;
  nextAction?: string;
}

function structured(result: unknown): SC {
  if (!result || typeof result !== 'object') {
    throw new Error('expected CallToolResult object');
  }
  const sc = Reflect.get(result, 'structuredContent');
  if (!sc || typeof sc !== 'object') {
    throw new Error('structuredContent missing');
  }
  // We trust the field shapes per the tool's contract.
  const snapshot: SC = {};
  for (const k of [
    'kind',
    'filePath',
    'sizeBytes',
    'topNodeKinds',
    'summary',
    'topLevelKeys',
    'slice',
    'code',
    'recoverable',
    'nextAction',
  ]) {
    const v = Reflect.get(sc, k);
    if (v !== undefined) {
      Reflect.set(snapshot, k, v);
    }
  }
  return snapshot;
}

describe('artifactReadSummary (T029)', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'artifact-summary-'));
  });

  after(() => {
    rmSync(tmp, {recursive: true, force: true});
  });

  it('summarizes a heap snapshot from disk', async () => {
    const result = await artifactReadSummary({
      filePath: 'tests/fixtures/example.heapsnapshot',
    });
    const sc = structured(result);
    assert.equal(sc.kind, 'heap');
    assert.ok(typeof sc.sizeBytes === 'number' && sc.sizeBytes > 0);
    assert.ok(Array.isArray(sc.topNodeKinds));
    assert.ok(
      sc.topNodeKinds && sc.topNodeKinds.length > 0,
      'should derive at least one node-kind bucket',
    );
  });

  it('summarizes a trace JSON (events + samplingWindowMs)', async () => {
    // Minimal trace shape: bare-array of events. parseRawTraceBuffer accepts
    // both shapes; samplingWindowMs may end up 0 if the trace engine cannot
    // parse a synthetic buffer, that's fine — we still want non-zero events
    // and a successful structuredContent envelope.
    const tracePath = path.join(tmp, 'trace.json');
    const events = [
      {
        pid: 1,
        tid: 1,
        ts: 1000,
        ph: 'M',
        cat: '__metadata',
        name: 'thread_name',
        args: {name: 'CrRendererMain'},
      },
      {
        pid: 1,
        tid: 1,
        ts: 1500,
        ph: 'X',
        dur: 100,
        cat: 'devtools.timeline',
        name: 'RunTask',
        args: {},
      },
      {
        pid: 1,
        tid: 1,
        ts: 1700,
        ph: 'X',
        dur: 50,
        cat: 'devtools.timeline',
        name: 'RunTask',
        args: {},
      },
    ];
    writeFileSync(tracePath, JSON.stringify({traceEvents: events}));

    const result = await artifactReadSummary({filePath: tracePath});
    const sc = structured(result);
    assert.equal(sc.kind, 'trace');
    assert.ok(typeof sc.sizeBytes === 'number' && sc.sizeBytes > 0);
    assert.ok(sc.summary, 'summary block should exist');
    assert.equal(sc.summary?.events, 3);
    assert.equal(typeof sc.summary?.samplingWindowMs, 'number');
    assert.ok(sc.summary?.coreMetrics);
  });

  it('summarizes a response artifact (top-level keys + default slice)', async () => {
    const responseDir = path.join(tmp, 'responses');
    const responsePath = path.join(responseDir, 'oversized.json');
    const dir = path.dirname(responsePath);
    // ensure responses/ exists for inferKind heuristic
    rmSync(dir, {recursive: true, force: true});
    writeFileSync.bind(null);
    const {mkdirSync} = await import('node:fs');
    mkdirSync(dir, {recursive: true});
    const payload = {alpha: 1, beta: [1, 2, 3], gamma: {nested: true}};
    writeFileSync(responsePath, JSON.stringify(payload));

    const result = await artifactReadSummary({filePath: responsePath});
    const sc = structured(result);
    assert.equal(sc.kind, 'response');
    assert.deepEqual(sc.topLevelKeys?.sort(), ['alpha', 'beta', 'gamma']);
    assert.ok(sc.slice);
    assert.equal(sc.slice?.start, 0);
    assert.ok(sc.slice && sc.slice.text.includes('alpha'));
  });

  it('honours explicit kind override', async () => {
    // Heap fixture, but we ask for a response-style read — the tool must
    // honour the override and treat it as opaque text.
    const result = await artifactReadSummary({
      filePath: 'tests/fixtures/example.heapsnapshot',
      kind: 'response',
      sliceStart: 0,
      sliceEnd: 100,
    });
    const sc = structured(result);
    assert.equal(sc.kind, 'response');
    assert.ok(sc.slice);
    assert.equal(sc.slice?.end, 100);
  });

  it('returns DISK_WRITE_FAILED structured error for missing path', async () => {
    const missing = path.join(tmp, 'does-not-exist.json');
    const result = await artifactReadSummary({filePath: missing});
    assert.equal(Reflect.get(result, 'isError'), true);
    const sc = structured(result);
    assert.equal(sc.code, 'DISK_WRITE_FAILED');
    assert.equal(sc.recoverable, true);
    assert.match(sc.nextAction ?? '', /read permission|exists/);
  });
});
