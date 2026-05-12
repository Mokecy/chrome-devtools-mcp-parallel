/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for stability-hardening CLI options (T014).
 */

import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {
  STABILITY_DEFAULTS,
  parseParallelArguments,
} from '../../src/parallel/cli.js';

const FAKE_ARGV = ['node', 'script'];

describe('parseParallelArguments — stability hardening options', () => {
  it('returns built-in defaults when neither CLI nor env supplies a value', () => {
    const args = parseParallelArguments('0.0.0', FAKE_ARGV, {});
    assert.equal(args.consoleBufferSize, STABILITY_DEFAULTS.consoleBufferSize);
    assert.equal(args.networkBufferSize, STABILITY_DEFAULTS.networkBufferSize);
    assert.equal(args.recordSizeCapKb, STABILITY_DEFAULTS.recordSizeCapKb);
    assert.equal(args.maxResponseSizeMb, STABILITY_DEFAULTS.maxResponseSizeMb);
    assert.equal(
      args.inlinePayloadMaxMb,
      STABILITY_DEFAULTS.inlinePayloadMaxMb,
    );
    assert.equal(
      args.reconnectMaxAttempts,
      STABILITY_DEFAULTS.reconnectMaxAttempts,
    );
    assert.equal(
      args.reconnectBackoffMs,
      STABILITY_DEFAULTS.reconnectBackoffMs,
    );
    assert.equal(args.circuitBreakAfter, STABILITY_DEFAULTS.circuitBreakAfter);
    assert.equal(args.heapSize, STABILITY_DEFAULTS.heapSize);
    assert.equal(args.memWarnPct, STABILITY_DEFAULTS.memWarnPct);
    assert.equal(args.memDangerPct, STABILITY_DEFAULTS.memDangerPct);
    assert.equal(
      args.memSampleIntervalSec,
      STABILITY_DEFAULTS.memSampleIntervalSec,
    );
    assert.equal(args.artifactDir, undefined);
  });

  it('honors CLI flag for buffer sizes', () => {
    const args = parseParallelArguments(
      '0.0.0',
      [
        ...FAKE_ARGV,
        '--console-buffer-size',
        '200',
        '--network-buffer-size',
        '750',
        '--record-size-cap-kb',
        '128',
      ],
      {},
    );
    assert.equal(args.consoleBufferSize, 200);
    assert.equal(args.networkBufferSize, 750);
    assert.equal(args.recordSizeCapKb, 128);
  });

  it('honors environment variables when CLI flag absent', () => {
    const args = parseParallelArguments('0.0.0', FAKE_ARGV, {
      CDM_CONSOLE_BUFFER_SIZE: '321',
      CDM_NETWORK_BUFFER_SIZE: '456',
      CDM_RECORD_SIZE_CAP_KB: '64',
      CDM_MAX_RESPONSE_SIZE_MB: '5',
      CDM_INLINE_PAYLOAD_MAX_MB: '3',
      CDM_RECONNECT_MAX_ATTEMPTS: '7',
      CDM_RECONNECT_BACKOFF_MS: '500',
      CDM_CIRCUIT_BREAK_AFTER: '4',
      CDM_HEAP_SIZE_MB: '8192',
      CDM_MEM_WARN_PCT: '70',
      CDM_MEM_DANGER_PCT: '90',
      CDM_MEM_SAMPLE_INTERVAL_SEC: '30',
      CDM_ARTIFACT_DIR: '/tmp/my-artifacts',
    });
    assert.equal(args.consoleBufferSize, 321);
    assert.equal(args.networkBufferSize, 456);
    assert.equal(args.recordSizeCapKb, 64);
    assert.equal(args.maxResponseSizeMb, 5);
    assert.equal(args.inlinePayloadMaxMb, 3);
    assert.equal(args.reconnectMaxAttempts, 7);
    assert.equal(args.reconnectBackoffMs, 500);
    assert.equal(args.circuitBreakAfter, 4);
    assert.equal(args.heapSize, 8192);
    assert.equal(args.memWarnPct, 70);
    assert.equal(args.memDangerPct, 90);
    assert.equal(args.memSampleIntervalSec, 30);
    assert.equal(args.artifactDir, '/tmp/my-artifacts');
  });

  it('CLI flag takes precedence over env when both provided', () => {
    const args = parseParallelArguments(
      '0.0.0',
      [...FAKE_ARGV, '--heap-size', '8192'],
      {CDM_HEAP_SIZE_MB: '2048'},
    );
    assert.equal(args.heapSize, 8192);
  });

  it('falls back to default when env value is non-numeric', () => {
    const args = parseParallelArguments('0.0.0', FAKE_ARGV, {
      CDM_HEAP_SIZE_MB: 'not-a-number',
    });
    assert.equal(args.heapSize, STABILITY_DEFAULTS.heapSize);
  });

  it('artifactDir CLI flag takes precedence over env', () => {
    const args = parseParallelArguments(
      '0.0.0',
      [...FAKE_ARGV, '--artifact-dir', '/cli/path'],
      {CDM_ARTIFACT_DIR: '/env/path'},
    );
    assert.equal(args.artifactDir, '/cli/path');
  });

  it('empty env string is treated as unset', () => {
    const args = parseParallelArguments('0.0.0', FAKE_ARGV, {
      CDM_ARTIFACT_DIR: '',
      CDM_HEAP_SIZE_MB: '',
    });
    assert.equal(args.artifactDir, undefined);
    assert.equal(args.heapSize, STABILITY_DEFAULTS.heapSize);
  });
});
