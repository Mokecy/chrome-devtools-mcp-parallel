/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * ArtifactDirManager — single source of truth for where large tool artifacts
 * (screenshots, traces, heap snapshots, oversized responses, crash logs) live
 * on disk (FR-006..011a, FR-024a).
 *
 * Two lifetimes:
 *   - ephemeral  : <os.tmpdir()>/chrome-devtools-mcp/<pid>/, auto-cleaned on
 *                  SIGINT / SIGTERM / uncaughtException.
 *   - persistent : caller-supplied directory, never auto-cleaned.
 *
 * Filenames embed instance id + ISO8601 timestamp + 4-char random suffix and
 * sanitize Win32-illegal characters so the same name is valid on every OS.
 *
 * See specs/001-stability-hardening/plan.md WP-2 + tasks.md T011.
 */

import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ArtifactLifetime = 'ephemeral' | 'persistent';

export type ArtifactKind =
  | 'screenshots'
  | 'traces'
  | 'heapsnapshots'
  | 'responses'
  | 'crashes';

export interface AllocatedArtifact {
  filePath: string;
  lifetime: ArtifactLifetime;
}

export interface ArtifactDirManagerOptions {
  persistentRoot?: string;
  pid?: number;
}

const ROOT_PREFIX = 'chrome-devtools-mcp';

/** Characters illegal in Win32 paths plus control chars. */
// eslint-disable-next-line no-control-regex -- intentional: strip raw control chars from instance ids
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Reserved Win32 device names (case-insensitive). */
const WIN32_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export function sanitizeFilenameSegment(input: string): string {
  let s = input.replace(ILLEGAL_FILENAME_CHARS, '_');
  // strip trailing dots/spaces (Win32 disallows)
  s = s.replace(/[. ]+$/, '');
  if (s.length === 0) {
    s = 'unnamed';
  }
  if (WIN32_RESERVED.has(s.toUpperCase())) {
    s = `_${s}`;
  }
  // cap segment length to keep total path under typical Win32 MAX_PATH cushion
  if (s.length > 64) {
    s = s.slice(0, 64);
  }
  return s;
}

export class ArtifactDirManager {
  readonly #pid: number;
  readonly #ephemeralRoot: string;
  readonly #persistentRoot: string | undefined;
  #cleanupInstalled = false;
  #cleaned = false;

  constructor(options: ArtifactDirManagerOptions = {}) {
    this.#pid = options.pid ?? process.pid;
    this.#ephemeralRoot = path.resolve(
      os.tmpdir(),
      ROOT_PREFIX,
      String(this.#pid),
    );
    this.#persistentRoot = options.persistentRoot
      ? path.resolve(options.persistentRoot)
      : undefined;
    mkdirSync(this.#ephemeralRoot, {recursive: true});
    if (this.#persistentRoot) {
      mkdirSync(this.#persistentRoot, {recursive: true});
    }
  }

  get pid(): number {
    return this.#pid;
  }

  getRoot(lifetime: ArtifactLifetime): string {
    if (lifetime === 'persistent') {
      if (!this.#persistentRoot) {
        throw new Error(
          'ArtifactDirManager: no persistent root configured (pass --artifact-dir).',
        );
      }
      return this.#persistentRoot;
    }
    return this.#ephemeralRoot;
  }

  /**
   * Allocate a new artifact path. The directory is created lazily; the file
   * itself is NOT created — caller writes content.
   *
   * Lifetime defaults to `persistent` when a persistent root is configured,
   * otherwise `ephemeral`. Callers that always want ephemeral must pass it
   * explicitly.
   */
  allocate(
    kind: ArtifactKind,
    instanceId: string,
    ext: string,
    lifetime?: ArtifactLifetime,
  ): AllocatedArtifact {
    const chosen: ArtifactLifetime =
      lifetime ?? (this.#persistentRoot ? 'persistent' : 'ephemeral');
    const root = this.getRoot(chosen);
    const subdir = path.join(root, kind);
    mkdirSync(subdir, {recursive: true});
    const safeId = sanitizeFilenameSegment(instanceId);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = randomBytes(2).toString('hex');
    const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
    const filename = `${safeId}-${ts}-${rand}${cleanExt}`;
    return {
      filePath: path.join(subdir, filename),
      lifetime: chosen,
    };
  }

  /**
   * Register process exit hooks that wipe the ephemeral root. Idempotent —
   * safe to call multiple times. Persistent root is never touched.
   */
  installCleanupHooks(): void {
    if (this.#cleanupInstalled) {
      return;
    }
    this.#cleanupInstalled = true;
    const cleanup = () => {
      this.cleanupEphemeral();
    };
    process.once('exit', cleanup);
    process.once('SIGINT', () => {
      cleanup();
      // do not call process.exit here; let other handlers decide
    });
    process.once('SIGTERM', () => {
      cleanup();
    });
    process.once('uncaughtException', () => {
      cleanup();
    });
  }

  /** Remove the ephemeral root recursively. Idempotent. */
  cleanupEphemeral(): void {
    if (this.#cleaned) {
      return;
    }
    this.#cleaned = true;
    try {
      rmSync(this.#ephemeralRoot, {recursive: true, force: true});
    } catch {
      // best-effort; cleanup failures are non-fatal during shutdown
    }
  }
}

let singleton: ArtifactDirManager | undefined;

/** Process-wide singleton accessor. Tests should NOT use this; instantiate directly. */
export function getArtifactDirManager(
  options?: ArtifactDirManagerOptions,
): ArtifactDirManager {
  if (!singleton) {
    singleton = new ArtifactDirManager(options);
    singleton.installCleanupHooks();
  }
  return singleton;
}

/** Test helper. Resets the singleton. Do not call from production code. */
export function resetArtifactDirManagerForTests(): void {
  singleton = undefined;
}
