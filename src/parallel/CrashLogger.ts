/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * CrashLogger (T067 / FR-023).
 *
 * Installs a pair of process-level handlers for fatal events:
 *   - `uncaughtException`    (sync + async exceptions that escaped)
 *   - `unhandledRejection`   (promise rejections without a catch)
 *
 * On either event, writes a structured JSON crash log under
 * `<artifactDir>/crashes/<ISO-ms>.log`, then re-throws so the runtime
 * still terminates with a non-zero exit code (FR-023 keeps the operator
 * fail-loud while preserving forensic context).
 *
 * Crash log shape:
 * ```json
 * {
 *   "ts": "2026-...",
 *   "kind": "uncaughtException" | "unhandledRejection",
 *   "error": { "message": "...", "stack": "...", "name": "..." },
 *   "activeInstances": [ ...InstanceHealthSnapshot ],
 *   "memorySamples":   [ ...MemorySample ],
 *   "recentToolCalls": [ ...ToolCallRecord ]
 * }
 * ```
 *
 * Writes are sync (`fs.writeFileSync`) because by the time we get here
 * the event loop is on its way out and we cannot rely on async I/O
 * draining before exit. The crashes/ directory is created up-front.
 */

import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

import {logger} from '../logger.js';

export interface CrashLoggerOptions {
  /** Root artifact dir; the logger writes under `<artifactDir>/crashes/`. */
  artifactDir: string;
  /** Producer for the active-instance snapshot (typically `registry.snapshotHealth()`). */
  collectActiveInstances?: () => unknown;
  /** Producer for recent memory samples (typically `memoryMonitor.recentSamples()`). */
  collectMemorySamples?: () => unknown;
  /** Producer for the most-recent tool call log (PageToolAdapter ring). */
  collectRecentToolCalls?: () => unknown;
  /**
   * Process exit policy. Default: re-raise via `process.exit(1)` after the
   * crash log is flushed. Tests pass `'noop'` to keep the runner alive.
   */
  exitPolicy?: 'exit' | 'noop';
}

interface CrashLogRecord {
  readonly ts: string;
  readonly kind: 'uncaughtException' | 'unhandledRejection';
  readonly error: {
    message: string;
    stack: string | null;
    name: string | null;
  };
  readonly activeInstances: unknown;
  readonly memorySamples: unknown;
  readonly recentToolCalls: unknown;
}

export class CrashLogger {
  readonly #options: CrashLoggerOptions;
  #installed = false;
  #crashesDir: string;

  #onUncaught: ((err: Error) => void) | null = null;
  #onUnhandled: ((reason: unknown) => void) | null = null;

  constructor(options: CrashLoggerOptions) {
    this.#options = options;
    this.#crashesDir = path.join(options.artifactDir, 'crashes');
  }

  /** Install handlers idempotently. Safe to call multiple times. */
  install(): void {
    if (this.#installed) {
      return;
    }
    this.#installed = true;

    // Best-effort up-front mkdir so the writePath is guaranteed to work
    // when we're under crash-time pressure.
    try {
      mkdirSync(this.#crashesDir, {recursive: true});
    } catch (err) {
      logger(
        `CrashLogger: failed to pre-create crashes dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.#onUncaught = (err: Error) => {
      this.#writeCrash('uncaughtException', err);
      this.#exit();
    };
    this.#onUnhandled = (reason: unknown) => {
      const err =
        reason instanceof Error
          ? reason
          : new Error(`Unhandled rejection: ${stringifyReason(reason)}`);
      this.#writeCrash('unhandledRejection', err);
      this.#exit();
    };

    process.on('uncaughtException', this.#onUncaught);
    process.on('unhandledRejection', this.#onUnhandled);
  }

  /** Detach handlers (test-only / shutdown hook). */
  uninstall(): void {
    if (!this.#installed) {
      return;
    }
    if (this.#onUncaught) {
      process.removeListener('uncaughtException', this.#onUncaught);
    }
    if (this.#onUnhandled) {
      process.removeListener('unhandledRejection', this.#onUnhandled);
    }
    this.#onUncaught = null;
    this.#onUnhandled = null;
    this.#installed = false;
  }

  /**
   * Write a crash log NOW for the given error. Public so observability
   * tools (or tests) can drive the writer without raising real exceptions.
   * Returns the absolute path of the file written, or null on failure.
   */
  writeCrash(
    kind: 'uncaughtException' | 'unhandledRejection',
    err: Error,
  ): string | null {
    return this.#writeCrash(kind, err);
  }

  get crashesDir(): string {
    return this.#crashesDir;
  }

  #writeCrash(
    kind: 'uncaughtException' | 'unhandledRejection',
    err: Error,
  ): string | null {
    const tsIso = new Date().toISOString();
    const safeTs = tsIso.replace(/[:.]/g, '-');
    const filePath = path.join(this.#crashesDir, `${safeTs}.log`);

    const record: CrashLogRecord = {
      ts: tsIso,
      kind,
      error: {
        message: err.message,
        stack: err.stack ?? null,
        name: err.name ?? null,
      },
      activeInstances: safeCall(this.#options.collectActiveInstances),
      memorySamples: safeCall(this.#options.collectMemorySamples),
      recentToolCalls: safeCall(this.#options.collectRecentToolCalls),
    };

    try {
      mkdirSync(this.#crashesDir, {recursive: true});
      writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
      // Best-effort stderr breadcrumb so operators see the path.
      process.stderr.write(`[CrashLogger] wrote ${filePath}\n`);
      return filePath;
    } catch (writeErr) {
      logger(
        `CrashLogger: failed to write crash log to ${filePath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
      return null;
    }
  }

  #exit(): void {
    const policy = this.#options.exitPolicy ?? 'exit';
    if (policy === 'exit') {
      // Use exit code 1 so wrappers / supervisors notice. We've already
      // flushed the crash log above; nothing else to drain.
      process.exit(1);
    }
  }
}

function safeCall(fn?: () => unknown): unknown {
  if (typeof fn !== 'function') {
    return null;
  }
  try {
    return fn();
  } catch (err) {
    return {
      collectorError: err instanceof Error ? err.message : String(err),
    };
  }
}

function stringifyReason(reason: unknown): string {
  if (reason === null || reason === undefined) {
    return String(reason);
  }
  if (typeof reason === 'string') {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}
