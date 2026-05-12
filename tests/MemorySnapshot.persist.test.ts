/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T028 — take_memory_snapshot persists to disk + emits structured summary.
 *
 * Stubs `Page.captureHeapSnapshot` to copy the existing
 * `tests/fixtures/example.heapsnapshot` to the requested path so we can
 * assert the new artifact-dir wiring + the
 * `structuredContent.heapSnapshotPersistence` envelope without invoking the
 * heavyweight V8 snapshotter for real.
 */

import assert from 'node:assert';
import {copyFileSync, existsSync, readFileSync, statSync} from 'node:fs';
import {after, before, describe, it} from 'node:test';

import sinon from 'sinon';

import {takeMemorySnapshot} from '../src/tools/memory.js';
import {
  getArtifactDirManager,
  resetArtifactDirManagerForTests,
} from '../src/utils/artifactDir.js';

import {withMcpContext} from './utils.js';

const FIXTURE = 'tests/fixtures/example.heapsnapshot';

interface HeapPersistence {
  filePath: string;
  sizeBytes: number;
  movedTo: string;
  topNodeKinds: Array<{kind: string; count: number}>;
}

function readHeapPersistence(sc: object): HeapPersistence {
  const hp = Reflect.get(sc, 'heapSnapshotPersistence');
  if (!hp || typeof hp !== 'object') {
    throw new Error('heapSnapshotPersistence missing in structuredContent');
  }
  const buckets = Reflect.get(hp, 'topNodeKinds');
  return {
    filePath: String(Reflect.get(hp, 'filePath') ?? ''),
    sizeBytes: Number(Reflect.get(hp, 'sizeBytes') ?? -1),
    movedTo: String(Reflect.get(hp, 'movedTo') ?? ''),
    topNodeKinds: Array.isArray(buckets)
      ? buckets.map(b => ({
          kind: String(Reflect.get(b, 'kind') ?? ''),
          count: Number(Reflect.get(b, 'count') ?? -1),
        }))
      : [],
  };
}

describe('take_memory_snapshot persistence (T028)', () => {
  before(() => {
    resetArtifactDirManagerForTests();
  });
  after(() => {
    resetArtifactDirManagerForTests();
  });

  it('persists snapshot to artifact dir when no filePath, and emits summary', async () => {
    const fixtureBytes = readFileSync(FIXTURE);
    await withMcpContext(async (response, context) => {
      const pptrPage = context.getSelectedPptrPage();
      // Make captureHeapSnapshot a no-op that just drops our fixture at the
      // requested path. Avoids spinning up the real V8 snapshotter.
      sinon
        .stub(pptrPage, 'captureHeapSnapshot')
        .callsFake(async (opts?: {path?: string}) => {
          if (!opts?.path) {
            throw new Error('captureHeapSnapshot called without path');
          }
          copyFileSync(FIXTURE, opts.path);
        });

      try {
        await takeMemorySnapshot.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const result = await response.handle('take_memory_snapshot', context);
        const hp = readHeapPersistence(result.structuredContent);

        // Disk file exists under ArtifactDirManager root.
        const root = getArtifactDirManager().getRoot('ephemeral');
        assert.ok(
          hp.filePath.startsWith(root),
          `heapSnapshotPersistence.filePath should live under ${root}, got ${hp.filePath}`,
        );
        assert.ok(
          hp.filePath.includes('heapsnapshots') &&
            hp.filePath.endsWith('.heapsnapshot'),
          `expected heapsnapshots/<id>.heapsnapshot, got ${hp.filePath}`,
        );
        assert.ok(existsSync(hp.filePath), 'on-disk file should exist');
        assert.equal(
          statSync(hp.filePath).size,
          fixtureBytes.byteLength,
          'on-disk file should match the fixture byte length',
        );
        assert.equal(
          hp.sizeBytes,
          fixtureBytes.byteLength,
          'sizeBytes should match the fixture byte length',
        );

        // Summary contract.
        assert.ok(
          hp.topNodeKinds.length > 0,
          'topNodeKinds should derive at least one bucket from the fixture',
        );
        for (const bucket of hp.topNodeKinds) {
          assert.equal(typeof bucket.kind, 'string');
          assert.ok(bucket.count >= 1);
        }

        // Legacy field — heapSnapshot.movedTo carries the same path so old
        // clients reading `heapSnapshot` still see a non-empty object.
        const legacy = Reflect.get(result.structuredContent, 'heapSnapshot');
        assert.ok(legacy && typeof legacy === 'object');
        assert.equal(Reflect.get(legacy, 'movedTo'), hp.filePath);
        assert.equal(hp.movedTo, hp.filePath);

        // Side effects retained.
        assert.match(
          response.responseLines.at(0) ?? '',
          /^Heap snapshot saved to .+\.heapsnapshot \(\d+ bytes\)\.$/,
        );
      } finally {
        sinon.restore();
      }
    });
  });
});
