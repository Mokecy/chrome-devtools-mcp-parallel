/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for src/utils/structuredError.ts (T007).
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  StructuredError,
  StructuredErrorCode,
  isStructuredError,
  toToolResult,
} from '../src/utils/structuredError.js';

describe('StructuredError', () => {
  it('exposes all required fields', () => {
    const err = new StructuredError({
      code: StructuredErrorCode.INSTANCE_DEAD,
      message: 'Instance is dead',
      recoverable: true,
      nextAction: 'call instance_recreate',
    });
    assert.strictEqual(err.code, 'INSTANCE_DEAD');
    assert.strictEqual(err.message, 'Instance is dead');
    assert.strictEqual(err.recoverable, true);
    assert.strictEqual(err.nextAction, 'call instance_recreate');
    assert.deepStrictEqual(err.detail, {});
    assert.ok(err instanceof Error);
  });

  it('merges detail into JSON serialization', () => {
    const err = new StructuredError({
      code: StructuredErrorCode.RESPONSE_TOO_LARGE,
      message: 'Response 5MB exceeds 2MB cap',
      recoverable: true,
      nextAction: 'fetch from filePath',
      detail: {filePath: '/tmp/foo.json', originalSize: 5_000_000},
    });
    const json = err.toJSON();
    assert.strictEqual(json.code, 'RESPONSE_TOO_LARGE');
    assert.strictEqual(json.filePath, '/tmp/foo.json');
    assert.strictEqual(json.originalSize, 5_000_000);
  });

  it('stores cause without TS lib mismatch', () => {
    const root = new Error('boom');
    const err = new StructuredError({
      code: StructuredErrorCode.DISK_WRITE_FAILED,
      message: 'write failed',
      recoverable: false,
      nextAction: 'check disk space',
      cause: root,
    });
    assert.strictEqual(Reflect.get(err, 'cause'), root);
  });

  it('isStructuredError type guard works', () => {
    const err = new StructuredError({
      code: StructuredErrorCode.RECORD_TOO_LARGE,
      message: 'm',
      recoverable: true,
      nextAction: 'n',
    });
    assert.strictEqual(isStructuredError(err), true);
    assert.strictEqual(isStructuredError(new Error('x')), false);
    assert.strictEqual(isStructuredError(null), false);
    assert.strictEqual(isStructuredError({code: 'X'}), false);
  });

  it('toToolResult produces uniform CallToolResult', () => {
    const err = new StructuredError({
      code: StructuredErrorCode.INSTANCE_RECONNECTING,
      message: 'instance is reconnecting',
      recoverable: true,
      nextAction: 'retry in 10s',
    });
    const res = toToolResult(err);
    assert.strictEqual(res.isError, true);
    assert.ok(Array.isArray(res.content));
    assert.strictEqual(res.content.length, 1);
    const first = res.content[0];
    assert.strictEqual(first.type, 'text');
    assert.match(
      first.type === 'text' ? first.text : '',
      /\[INSTANCE_RECONNECTING\]/,
    );
    const sc = res.structuredContent;
    assert.ok(sc);
    assert.strictEqual(sc?.code, 'INSTANCE_RECONNECTING');
    assert.strictEqual(sc?.recoverable, true);
    assert.strictEqual(sc?.nextAction, 'retry in 10s');
  });

  it('error code constants are stable', () => {
    assert.deepStrictEqual(Object.keys(StructuredErrorCode).sort(), [
      'DISK_WRITE_FAILED',
      'INLINE_PAYLOAD_TOO_LARGE',
      'INSTANCE_DEAD',
      'INSTANCE_PROTOCOL_ERROR',
      'INSTANCE_RECONNECTING',
      'RECORD_TOO_LARGE',
      'RESPONSE_TOO_LARGE',
    ]);
  });
});
