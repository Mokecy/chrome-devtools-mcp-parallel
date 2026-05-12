/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T069 — Observability + system_observe unit tests (FR-024b).
 *
 * Drives the snapshot path with a structural InstanceListSource so we
 * never instantiate a real McpContext / browser; the only real piece is
 * `MemoryMonitor`, which is itself driven via injected sampler funcs.
 */

import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it, mock} from 'node:test';

import {systemObserve} from '../../src/parallel/managementTools/systemObserve.js';
import {MemoryMonitor} from '../../src/parallel/MemoryMonitor.js';
import {
  Observability,
  type InstanceListSource,
  type ObservableBufferMeta,
  type ObservableInstance,
} from '../../src/parallel/Observability.js';

const FAKE_LIMIT = 4096 * 1024 * 1024; // 4 GB

function makeMu(heapUsedBytes: number): NodeJS.MemoryUsage {
  return {
    rss: heapUsedBytes + 100 * 1024 * 1024,
    heapTotal: heapUsedBytes,
    heapUsed: heapUsedBytes,
    external: 0,
    arrayBuffers: 0,
  };
}

function meta(size: number, evicted: number): ObservableBufferMeta {
  return {total: {size, evicted}};
}

interface FakeInstanceOpts {
  id: string;
  state?: string;
  consoleMeta?: ObservableBufferMeta;
  networkMeta?: ObservableBufferMeta;
  /** Throw out of getSelectedMcpPage to mimic a freshly-created instance. */
  noSelectedPage?: boolean;
}

function makeInstance(opts: FakeInstanceOpts): ObservableInstance {
  const consoleMeta = opts.consoleMeta ?? meta(0, 0);
  const networkMeta = opts.networkMeta ?? meta(0, 0);
  const sentinelPage = {pptrPage: {}};
  return {
    id: opts.id,
    state: opts.state ?? 'ready',
    mcpContext: {
      getSelectedMcpPage(): unknown {
        if (opts.noSelectedPage) {
          throw new Error('no selected page');
        }
        return sentinelPage;
      },
      getConsoleBufferMeta(): ObservableBufferMeta {
        return consoleMeta;
      },
      getNetworkBufferMeta(): ObservableBufferMeta {
        return networkMeta;
      },
    },
  };
}

function makeRegistry(instances: ObservableInstance[]): InstanceListSource {
  return {
    list(): readonly ObservableInstance[] {
      return instances;
    },
  };
}

describe('Observability snapshot (T069)', () => {
  let stderrBuf: string[];
  let tmpRoot: string;

  beforeEach(() => {
    stderrBuf = [];
    mock.method(process.stderr, 'write', (chunk: unknown): boolean => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString()
            : String(chunk);
      stderrBuf.push(text);
      return true;
    });
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'obs-test-'));
  });

  afterEach(() => {
    mock.restoreAll();
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('aggregates per-instance buffer counters and lifecycle state', async () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.5)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    await monitor.tick();

    const registry = makeRegistry([
      makeInstance({
        id: 'alpha',
        state: 'ready',
        consoleMeta: meta(7, 3),
        networkMeta: meta(11, 4),
      }),
      makeInstance({
        id: 'beta',
        state: 'reconnecting',
        consoleMeta: meta(0, 0),
        networkMeta: meta(2, 9),
      }),
    ]);

    const obs = new Observability({registry, memoryMonitor: monitor});
    const snap = obs.snapshot();

    assert.equal(snap.instances.length, 2);
    const alpha = snap.instances.find(i => i.id === 'alpha');
    assert.ok(alpha);
    assert.equal(alpha.state, 'ready');
    assert.deepEqual(alpha.console, {retained: 7, evicted: 3});
    assert.deepEqual(alpha.network, {retained: 11, evicted: 4});

    const beta = snap.instances.find(i => i.id === 'beta');
    assert.ok(beta);
    assert.equal(beta.state, 'reconnecting');
    assert.deepEqual(beta.network, {retained: 2, evicted: 9});

    // ~50% of 4GB — leave a slop range, MemoryMonitor recomputes pct.
    assert.ok(snap.memory.heapPct >= 49 && snap.memory.heapPct <= 51);
    assert.ok(snap.memory.rssMb > 0);
    assert.ok(typeof snap.ts === 'string' && snap.ts.endsWith('Z'));

    assert.equal(snap.recentMemorySamples, undefined);
  });

  it('falls back to zeros when no MemoryMonitor sample exists yet', () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.5)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    const obs = new Observability({
      registry: makeRegistry([]),
      memoryMonitor: monitor,
    });
    const snap = obs.snapshot();
    assert.deepEqual(snap.memory, {rssMb: 0, heapUsedMb: 0, heapPct: 0});
    assert.equal(snap.instances.length, 0);
  });

  it('returns zero buffer counters when getSelectedMcpPage throws', () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.2)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    const registry = makeRegistry([
      makeInstance({id: 'lonely', noSelectedPage: true}),
    ]);
    const obs = new Observability({registry, memoryMonitor: monitor});
    const snap = obs.snapshot();
    assert.equal(snap.instances.length, 1);
    assert.deepEqual(snap.instances[0].console, {retained: 0, evicted: 0});
    assert.deepEqual(snap.instances[0].network, {retained: 0, evicted: 0});
  });

  it('embeds recentMemorySamples when requested', async () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.3)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    await monitor.tick();
    await monitor.tick();
    const obs = new Observability({
      registry: makeRegistry([]),
      memoryMonitor: monitor,
    });
    const snap = obs.snapshot({includeMemorySamples: true});
    assert.ok(Array.isArray(snap.recentMemorySamples));
    assert.ok((snap.recentMemorySamples ?? []).length >= 1);
  });

  it('reports artifact-dir disk usage from a real walk', async () => {
    const ephemeralDir = path.join(tmpRoot, 'ephemeral');
    const persistentDir = path.join(tmpRoot, 'persistent');
    mkdirSync(ephemeralDir, {recursive: true});
    mkdirSync(persistentDir, {recursive: true});
    writeFileSync(path.join(ephemeralDir, 'a.bin'), Buffer.alloc(1024));
    writeFileSync(path.join(ephemeralDir, 'b.bin'), Buffer.alloc(2048));
    mkdirSync(path.join(persistentDir, 'nested'), {recursive: true});
    writeFileSync(
      path.join(persistentDir, 'nested', 'c.bin'),
      Buffer.alloc(4096),
    );

    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.1)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    const obs = new Observability({
      registry: makeRegistry([]),
      memoryMonitor: monitor,
      artifactEphemeralDir: ephemeralDir,
      artifactPersistentDir: persistentDir,
    });
    const snap = obs.snapshot();
    assert.equal(snap.artifactDir.ephemeralBytes, 3072);
    assert.equal(snap.artifactDir.persistentBytes, 4096);
  });

  it('caches artifact-dir sizes between back-to-back snapshots', () => {
    const ephemeralDir = path.join(tmpRoot, 'cache-e');
    mkdirSync(ephemeralDir, {recursive: true});
    writeFileSync(path.join(ephemeralDir, 'a'), Buffer.alloc(512));

    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.1)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    const obs = new Observability({
      registry: makeRegistry([]),
      memoryMonitor: monitor,
      artifactEphemeralDir: ephemeralDir,
    });
    const first = obs.snapshot();
    assert.equal(first.artifactDir.ephemeralBytes, 512);
    // Add more bytes — cache window is ~10s so the snapshot should not pick up.
    writeFileSync(path.join(ephemeralDir, 'b'), Buffer.alloc(1024));
    const second = obs.snapshot();
    assert.equal(
      second.artifactDir.ephemeralBytes,
      512,
      'second call within cache window must reuse cached value',
    );
  });

  it('startPeriodicLog emits a tagged JSON line on stderr and stops cleanly', async () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.4)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    await monitor.tick();
    const obs = new Observability({
      registry: makeRegistry([
        makeInstance({
          id: 'p1',
          consoleMeta: meta(1, 0),
          networkMeta: meta(2, 0),
        }),
      ]),
      memoryMonitor: monitor,
    });
    obs.startPeriodicLog(15);
    // Idempotent — second call is a no-op.
    obs.startPeriodicLog(15);
    await new Promise(resolve => setTimeout(resolve, 60));
    obs.stop();
    obs.stop(); // safe double-stop

    const matches = stderrBuf.filter(l => l.includes('[observability]'));
    assert.ok(matches.length >= 1, 'expected at least one observability line');
    const payload = matches[0].replace('[observability] ', '').trim();
    const parsed: unknown = JSON.parse(payload);
    assert.ok(
      parsed && typeof parsed === 'object' && 'instances' in parsed,
      'observability line must be valid JSON snapshot',
    );
  });

  it('startPeriodicLog is a no-op when intervalMs <= 0', () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.1)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    const obs = new Observability({
      registry: makeRegistry([]),
      memoryMonitor: monitor,
    });
    obs.startPeriodicLog(0);
    obs.startPeriodicLog(-1);
    obs.startPeriodicLog(Number.NaN);
    obs.stop();
    assert.equal(
      stderrBuf.filter(l => l.includes('[observability]')).length,
      0,
    );
  });
});

describe('system_observe management tool (T069)', () => {
  it('returns the snapshot as combined summary + JSON content', async () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.6)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    await monitor.tick();
    const registry = makeRegistry([
      makeInstance({
        id: 'tool-1',
        state: 'ready',
        consoleMeta: meta(5, 1),
        networkMeta: meta(8, 2),
      }),
    ]);
    const obs = new Observability({registry, memoryMonitor: monitor});

    const result = await systemObserve({}, obs);
    assert.equal(result.content?.length, 1);
    const block = result.content?.[0];
    assert.ok(block && block.type === 'text');
    const text = block.text;
    // summary line + blank + JSON
    assert.ok(text.includes('system_observe @ '));
    assert.ok(text.includes('memory: rss='));
    assert.ok(text.includes('tool-1'));
    assert.ok(text.includes('console=5/6'));
    assert.ok(text.includes('network=8/10'));

    const jsonIdx = text.indexOf('\n{');
    assert.ok(jsonIdx > 0, 'tool output should embed JSON blob');
    const parsed: {
      instances: Array<{id: string; console: {retained: number}}>;
      recentMemorySamples?: unknown[];
    } = JSON.parse(text.slice(jsonIdx).trim());
    assert.equal(parsed.instances.length, 1);
    assert.equal(parsed.instances[0].id, 'tool-1');
    assert.equal(parsed.recentMemorySamples, undefined);
  });

  it('includeMemorySamples=true embeds the rolling buffer', async () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.4)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    await monitor.tick();
    await monitor.tick();
    const obs = new Observability({
      registry: makeRegistry([]),
      memoryMonitor: monitor,
    });

    const result = await systemObserve({includeMemorySamples: true}, obs);
    const block = result.content?.[0];
    assert.ok(block && block.type === 'text');
    const jsonIdx = block.text.indexOf('\n{');
    const parsed: {recentMemorySamples?: unknown[]} = JSON.parse(
      block.text.slice(jsonIdx).trim(),
    );
    assert.ok(Array.isArray(parsed.recentMemorySamples));
    assert.ok((parsed.recentMemorySamples ?? []).length >= 1);
  });

  it('renders "instances: (none)" when registry is empty', async () => {
    const monitor = new MemoryMonitor({
      memoryUsageFn: () => makeMu(Math.floor(FAKE_LIMIT * 0.1)),
      heapStatisticsFn: () => ({heap_size_limit: FAKE_LIMIT}),
    });
    const obs = new Observability({
      registry: makeRegistry([]),
      memoryMonitor: monitor,
    });
    const result = await systemObserve({}, obs);
    const block = result.content?.[0];
    assert.ok(block && block.type === 'text');
    assert.ok(block.text.includes('instances: (none)'));
  });
});
