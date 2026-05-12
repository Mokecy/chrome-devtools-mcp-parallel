/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T072 — cross-platform artifact path hardening (FR-024a / FR-025).
 *
 * Validates that filename + path construction produced by
 * `ArtifactDirManager` is portable: a path generated on POSIX must still
 * be a legal Win32 filename when re-parsed by `path.win32`, and vice
 * versa. Complements `tests/ArtifactDir.test.ts` (which exercises the
 * runtime `path` module on the host OS).
 */

import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {
  ArtifactDirManager,
  sanitizeFilenameSegment,
} from '../src/utils/artifactDir.js';

/**
 * Win32-illegal characters per
 * https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file —
 * `< > : " / \ | ? *` plus ASCII control range. Must NEVER appear in a
 * basename produced by the manager regardless of host OS.
 */
// eslint-disable-next-line no-control-regex -- intentional: probe for raw control chars in basenames
const WIN32_ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/;

describe('cross-platform artifact paths (T072)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'cdmcp-xpaths-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('sanitizeFilenameSegment strips characters illegal on Win32', () => {
    const id = 'a:b\\c|d?e*f<g>h"i';
    const safe = sanitizeFilenameSegment(id);
    assert.ok(
      !WIN32_ILLEGAL.test(safe),
      `sanitised "${safe}" still contains a Win32-illegal char`,
    );
    // Must round-trip through both posix and win32 basename parsers as
    // a *bare* segment (no separators reintroduced).
    assert.strictEqual(path.posix.basename(safe), safe);
    assert.strictEqual(path.win32.basename(safe), safe);
  });

  it('sanitizeFilenameSegment handles the spec example "a:b" -> "a_b"', () => {
    assert.strictEqual(sanitizeFilenameSegment('a:b'), 'a_b');
  });

  it('allocate() returns an absolute path with a sanitised basename', () => {
    const persistRoot = path.join(tmpRoot, 'persistent');
    const mgr = new ArtifactDirManager({
      persistentRoot: persistRoot,
      pid: 9991,
    });

    // weird instance id — every Win32-illegal char + reserved name fragment
    const dirty = 'inst:1/with\\bad|chars?<>"*';
    const allocated = mgr.allocate('responses', dirty, 'json');

    // Absolute on the host OS we're actually running on.
    assert.ok(path.isAbsolute(allocated.filePath), 'filePath must be absolute');
    // Must live under the resolved persistent root.
    assert.ok(
      allocated.filePath.startsWith(path.resolve(persistRoot)),
      `expected "${allocated.filePath}" to start with "${path.resolve(persistRoot)}"`,
    );

    const base = path.basename(allocated.filePath);
    assert.ok(
      !WIN32_ILLEGAL.test(base),
      `basename "${base}" contains a Win32-illegal character`,
    );
    // Sanitiser collapses the dirty id into a single safe prefix
    // followed by `-<ts>-<rand>.json`. It must NOT still contain the
    // raw separators or chars that would re-introduce path traversal.
    assert.ok(!base.includes('/'), 'basename should not retain "/"');
    assert.ok(!base.includes('\\'), 'basename should not retain "\\"');
  });

  it('allocate() never produces a Win32 reserved device name as basename', () => {
    const persistRoot = path.join(tmpRoot, 'p2');
    const mgr = new ArtifactDirManager({
      persistentRoot: persistRoot,
      pid: 9992,
    });
    for (const reserved of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
      const allocated = mgr.allocate('crashes', reserved, 'log');
      const base = path.basename(allocated.filePath);
      // Sanitiser prefixes reserved names with `_`, then appends the
      // unique `-<ts>-<rand>.log` suffix. Either way the bare name MUST
      // NOT equal the reserved word once the extension is stripped.
      const stem = base.replace(/\.log$/, '');
      assert.notStrictEqual(
        stem.toUpperCase(),
        reserved,
        `reserved name "${reserved}" leaked into basename "${base}"`,
      );
      assert.ok(
        stem.startsWith('_'),
        `reserved name "${reserved}" expected to be prefixed with "_"`,
      );
    }
  });

  it('persistent root with redundant segments is normalised + absolute', () => {
    // Path with a `..` redirect — constructor must `path.resolve()` it.
    const messy = path.join(tmpRoot, 'a', '..', 'rel-root');
    const mgr = new ArtifactDirManager({persistentRoot: messy, pid: 9993});
    const root = mgr.getRoot('persistent');
    assert.ok(path.isAbsolute(root), 'getRoot must return absolute path');
    assert.strictEqual(root, path.resolve(messy));
    assert.ok(!root.includes(`${path.sep}..${path.sep}`), 'no .. in result');
  });

  it('ephemeral root is absolute and lives under os.tmpdir()', () => {
    const mgr = new ArtifactDirManager({pid: 9994});
    const root = mgr.getRoot('ephemeral');
    assert.ok(path.isAbsolute(root));
    assert.ok(
      root.startsWith(path.resolve(tmpdir())),
      `expected ephemeral root "${root}" to be under "${tmpdir()}"`,
    );
    mgr.cleanupEphemeral();
  });
});
