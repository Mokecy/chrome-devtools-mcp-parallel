/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 */

import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';

import {parseParallelArguments} from '../../src/parallel/cli.js';

const FAKE_ARGV = ['node', 'script'];

describe('parseParallelArguments', () => {
  it('preserves commas inside --chrome-arg=--disable-features=A,B', () => {
    const args = parseParallelArguments('0.0.0', [
      ...FAKE_ARGV,
      '--chrome-arg=--disable-features=PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks',
    ]);
    assert.deepEqual(args.chromeArg, [
      '--disable-features=PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks',
    ]);
  });

  it('supports multiple --chrome-arg with both = and space forms', () => {
    const args = parseParallelArguments('0.0.0', [
      ...FAKE_ARGV,
      '--chrome-arg',
      '--use-fake-ui-for-media-stream',
      '--chrome-arg=--disable-features=A,B,C',
      '--chrome-arg',
      '--enable-features=X,Y',
    ]);
    assert.deepEqual(args.chromeArg, [
      '--use-fake-ui-for-media-stream',
      '--disable-features=A,B,C',
      '--enable-features=X,Y',
    ]);
  });

  it('preserves --ignore-default-chrome-arg with comma values', () => {
    const args = parseParallelArguments('0.0.0', [
      ...FAKE_ARGV,
      '--ignore-default-chrome-arg=--disable-extensions,--mute-audio',
    ]);
    assert.deepEqual(args.ignoreDefaultChromeArg, [
      '--disable-extensions,--mute-audio',
    ]);
  });

  it('still parses other flags normally', () => {
    const args = parseParallelArguments('0.0.0', [
      ...FAKE_ARGV,
      '--headless',
      '--max-instances',
      '7',
      '--chrome-arg=--no-sandbox',
    ]);
    assert.equal(args.headless, true);
    assert.equal(args.maxInstances, 7);
    assert.deepEqual(args.chromeArg, ['--no-sandbox']);
  });
});
