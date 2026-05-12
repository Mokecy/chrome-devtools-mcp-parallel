/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T027 — performance_stop_trace persists to disk + emits structured summary.
 *
 * Follows the same sinon-stubbed pattern as `tests/tools/performance.test.ts`
 * to avoid running a real trace, but adds:
 *   - assertion that an on-disk `.json` artifact lives under the configured
 *     ArtifactDirManager root when no `filePath` was supplied;
 *   - assertion that `structuredContent.tracePersistence` carries
 *     `{ filePath, sizeBytes, summary: {events, samplingWindowMs, coreMetrics}, movedTo }`.
 */

import assert from 'node:assert';
import {existsSync, statSync} from 'node:fs';
import {after, afterEach, before, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {stopTrace} from '../src/tools/performance.js';
import {
  getArtifactDirManager,
  resetArtifactDirManagerForTests,
} from '../src/utils/artifactDir.js';

import {loadTraceAsBuffer} from './trace-processing/fixtures/load.js';
import {withMcpContext} from './utils.js';

interface TracePersistence {
  filePath: string;
  sizeBytes: number;
  movedTo: string;
  summary: {
    events: number;
    samplingWindowMs: number;
    coreMetrics: {lcpMs?: number; clsScore?: number; inpMs?: number};
  };
}

function readTracePersistence(sc: object): TracePersistence {
  const tp = Reflect.get(sc, 'tracePersistence');
  if (!tp || typeof tp !== 'object') {
    throw new Error('tracePersistence missing in structuredContent');
  }
  return {
    filePath: String(Reflect.get(tp, 'filePath') ?? ''),
    sizeBytes: Number(Reflect.get(tp, 'sizeBytes') ?? -1),
    movedTo: String(Reflect.get(tp, 'movedTo') ?? ''),
    summary: {
      events: Number(
        Reflect.get(Reflect.get(tp, 'summary') ?? {}, 'events') ?? -1,
      ),
      samplingWindowMs: Number(
        Reflect.get(Reflect.get(tp, 'summary') ?? {}, 'samplingWindowMs') ?? -1,
      ),
      coreMetrics: (() => {
        const cm = Reflect.get(Reflect.get(tp, 'summary') ?? {}, 'coreMetrics');
        return cm && typeof cm === 'object' ? Object.assign({}, cm) : {};
      })(),
    },
  };
}

describe('performance_stop_trace persistence (T027)', () => {
  before(() => {
    // Force a deterministic ephemeral root for the test run.
    resetArtifactDirManagerForTests();
  });
  after(() => {
    resetArtifactDirManagerForTests();
  });

  // The upstream performance suite stubs fetch globally; do the same here to
  // keep CrUX off during the trace parse.
  beforeEach(() => {
    sinon.stub(globalThis, 'fetch').callsFake(async () => {
      throw new Error('CrUX disabled in T027');
    });
  });
  afterEach(() => {
    sinon.restore();
  });

  it('persists trace to artifact dir when no filePath, and emits summary', async () => {
    const rawData = loadTraceAsBuffer('basic-trace.json.gz');
    await withMcpContext(
      async (response, context) => {
        context.setIsRunningPerformanceTrace(true);
        const selectedPage = context.getSelectedPptrPage();
        sinon.stub(selectedPage.tracing, 'stop').resolves(rawData);

        await stopTrace.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const result = await response.handle('performance_stop_trace', context);
        const tp = readTracePersistence(result.structuredContent);

        // Disk artifact lives under the ArtifactDirManager root.
        const root = getArtifactDirManager().getRoot('ephemeral');
        assert.ok(
          tp.filePath.startsWith(root),
          `tracePersistence.filePath should live under ${root}, got ${tp.filePath}`,
        );
        assert.ok(
          tp.filePath.includes('traces') && tp.filePath.endsWith('.json'),
          `expected traces/<id>.json, got ${tp.filePath}`,
        );
        assert.ok(existsSync(tp.filePath), 'on-disk file should exist');
        assert.equal(
          statSync(tp.filePath).size,
          tp.sizeBytes,
          'sizeBytes should match on-disk size',
        );

        // Summary contract.
        assert.ok(tp.summary.events > 0, 'events should be > 0');
        assert.equal(typeof tp.summary.samplingWindowMs, 'number');
        assert.ok(tp.summary.samplingWindowMs >= 0);
        assert.ok(
          tp.summary.coreMetrics && typeof tp.summary.coreMetrics === 'object',
          'coreMetrics should be a (possibly empty) object',
        );

        // Legacy field — moveTo always equals filePath.
        assert.equal(tp.movedTo, tp.filePath);

        // Side effects retained.
        assert.ok(
          response.responseLines.includes(
            'The performance trace has been stopped.',
          ),
        );
      },
      {performanceCrux: false},
    );
  });
});
