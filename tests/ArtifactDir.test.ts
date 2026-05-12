/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for src/utils/artifactDir.ts (T008).
 */

import assert from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {
  ArtifactDirManager,
  sanitizeFilenameSegment,
} from '../src/utils/artifactDir.js';

describe('sanitizeFilenameSegment', () => {
  it('replaces Win32-illegal characters with underscore', () => {
    assert.strictEqual(sanitizeFilenameSegment('a:b'), 'a_b');
    assert.strictEqual(sanitizeFilenameSegment('a/b\\c|d?e*f'), 'a_b_c_d_e_f');
    assert.strictEqual(sanitizeFilenameSegment('a<b>c"d'), 'a_b_c_d');
  });

  it('strips trailing dots and spaces', () => {
    assert.strictEqual(sanitizeFilenameSegment('foo. '), 'foo');
    assert.strictEqual(sanitizeFilenameSegment('bar...'), 'bar');
  });

  it('escapes Win32 reserved names', () => {
    assert.strictEqual(sanitizeFilenameSegment('CON'), '_CON');
    assert.strictEqual(sanitizeFilenameSegment('com1'), '_com1');
    assert.strictEqual(sanitizeFilenameSegment('NUL'), '_NUL');
  });

  it('returns "unnamed" for empty input', () => {
    assert.strictEqual(sanitizeFilenameSegment(''), 'unnamed');
    assert.strictEqual(sanitizeFilenameSegment('...'), 'unnamed');
  });

  it('caps segment length to 64', () => {
    const long = 'x'.repeat(200);
    assert.strictEqual(sanitizeFilenameSegment(long).length, 64);
  });
});

describe('ArtifactDirManager', () => {
  let testPid: number;
  let persistRoot: string;

  beforeEach(() => {
    // Use a synthetic pid so each test gets an isolated ephemeral root.
    testPid = 100_000 + Math.floor(Math.random() * 100_000);
    persistRoot = mkdtempSync(path.join(os.tmpdir(), 'cdm-persist-'));
  });

  afterEach(() => {
    // Clean up persist test dir
    rmSync(persistRoot, {recursive: true, force: true});
    // Clean up any leftover ephemeral dir from this synthetic pid
    rmSync(path.join(os.tmpdir(), 'chrome-devtools-mcp', String(testPid)), {
      recursive: true,
      force: true,
    });
  });

  it('creates ephemeral root under tmpdir keyed by pid', () => {
    const mgr = new ArtifactDirManager({pid: testPid});
    const root = mgr.getRoot('ephemeral');
    assert.ok(existsSync(root), 'ephemeral root must exist');
    assert.ok(root.includes(String(testPid)), 'root must contain pid');
    assert.ok(path.isAbsolute(root), 'root must be absolute');
  });

  it('throws when persistent root not configured', () => {
    const mgr = new ArtifactDirManager({pid: testPid});
    assert.throws(() => mgr.getRoot('persistent'));
  });

  it('uses persistent root when configured', () => {
    const mgr = new ArtifactDirManager({
      pid: testPid,
      persistentRoot: persistRoot,
    });
    assert.strictEqual(mgr.getRoot('persistent'), path.resolve(persistRoot));
  });

  it('allocate produces filenames with instanceId + timestamp + ext', () => {
    const mgr = new ArtifactDirManager({pid: testPid});
    const allocated = mgr.allocate('screenshots', 'inst-1', 'png');
    const base = path.basename(allocated.filePath);
    assert.match(
      base,
      /^inst-1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{4}\.png$/,
    );
    assert.strictEqual(allocated.lifetime, 'ephemeral');
    // dir created
    assert.ok(existsSync(path.dirname(allocated.filePath)));
  });

  it('allocate sanitizes weird instance ids', () => {
    const mgr = new ArtifactDirManager({pid: testPid});
    const allocated = mgr.allocate('responses', 'a:b/c', 'json');
    const base = path.basename(allocated.filePath);
    assert.match(base, /^a_b_c-/);
  });

  it('allocate defaults to persistent when persistent root configured', () => {
    const mgr = new ArtifactDirManager({
      pid: testPid,
      persistentRoot: persistRoot,
    });
    const allocated = mgr.allocate('traces', 'inst-1', 'json');
    assert.strictEqual(allocated.lifetime, 'persistent');
    assert.ok(allocated.filePath.startsWith(path.resolve(persistRoot)));
  });

  it('allocate honors explicit ephemeral lifetime even with persistent root', () => {
    const mgr = new ArtifactDirManager({
      pid: testPid,
      persistentRoot: persistRoot,
    });
    const allocated = mgr.allocate('traces', 'inst-1', 'json', 'ephemeral');
    assert.strictEqual(allocated.lifetime, 'ephemeral');
  });

  it('cleanupEphemeral wipes ephemeral but preserves persistent', () => {
    const mgr = new ArtifactDirManager({
      pid: testPid,
      persistentRoot: persistRoot,
    });
    const ep = mgr.allocate('responses', 'i', 'txt', 'ephemeral');
    const pe = mgr.allocate('responses', 'i', 'txt', 'persistent');
    writeFileSync(ep.filePath, 'eph');
    writeFileSync(pe.filePath, 'persist');
    assert.ok(existsSync(ep.filePath));
    assert.ok(existsSync(pe.filePath));

    mgr.cleanupEphemeral();

    assert.ok(!existsSync(ep.filePath), 'ephemeral file should be removed');
    assert.ok(
      !existsSync(mgr.getRoot('ephemeral')),
      'ephemeral root should be removed',
    );
    assert.ok(existsSync(pe.filePath), 'persistent file must survive');
    assert.strictEqual(readFileSync(pe.filePath, 'utf8'), 'persist');
  });

  it('cleanupEphemeral is idempotent', () => {
    const mgr = new ArtifactDirManager({pid: testPid});
    mgr.cleanupEphemeral();
    mgr.cleanupEphemeral(); // must not throw
  });

  it('installCleanupHooks is idempotent', () => {
    const mgr = new ArtifactDirManager({pid: testPid});
    const before = process.listenerCount('exit');
    mgr.installCleanupHooks();
    mgr.installCleanupHooks();
    mgr.installCleanupHooks();
    const after = process.listenerCount('exit');
    // exactly one new listener added across multiple install calls
    assert.strictEqual(after, before + 1);
  });
});
