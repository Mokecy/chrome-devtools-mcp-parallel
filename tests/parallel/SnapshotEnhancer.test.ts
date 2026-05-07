/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for SnapshotEnhancer pure functions (denoise + diff).
 * T046.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {denoise, computeDiff} from '../../src/parallel/SnapshotEnhancer.js';

describe('SnapshotEnhancer', () => {
  describe('denoise', () => {
    it('removes pure generic lines', () => {
      const input = 'heading "Title"\ngeneric\nbutton "Submit"';
      const result = denoise(input);
      assert.ok(!result.includes('generic'));
      assert.ok(result.includes('heading "Title"'));
      assert.ok(result.includes('button "Submit"'));
    });

    it('removes InlineTextBox lines', () => {
      const input = 'text "Hello"\n  InlineTextBox\nlink "Click"';
      const result = denoise(input);
      assert.ok(!result.includes('InlineTextBox'));
    });

    it('collapses multiple empty lines to one', () => {
      const input = 'line1\n\n\n\nline2';
      const result = denoise(input);
      assert.equal(result, 'line1\n\nline2');
    });

    it('preserves non-noise content', () => {
      const input = 'heading "Generic Products"\nbutton "generic-submit"';
      const result = denoise(input);
      // "Generic Products" is not a standalone "generic" line
      assert.ok(result.includes('heading "Generic Products"'));
      assert.ok(result.includes('button "generic-submit"'));
    });
  });

  describe('computeDiff', () => {
    it('identical content returns diff with 0% change', () => {
      const text = 'line1\nline2\nline3';
      const result = computeDiff(text, text);
      assert.equal(result.isDiff, true);
      assert.equal(result.changeRate, 0);
    });

    it('small change returns diff-only (≤35%)', () => {
      const prev =
        'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
      const current =
        'line1\nline2\nCHANGED\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
      const result = computeDiff(prev, current);
      assert.equal(result.isDiff, true);
      assert.ok(result.changeRate <= 0.35);
      assert.ok(result.text.includes('+ CHANGED'));
      assert.ok(result.text.includes('- line3'));
      assert.ok(result.text.includes('[snapshot diff,'));
    });

    it('large change returns full text (>35%)', () => {
      const prev = 'a\nb\nc\nd\ne';
      const current = 'x\ny\nz\nw\nv';
      const result = computeDiff(prev, current);
      assert.equal(result.isDiff, false);
      assert.ok(result.changeRate > 0.35);
      assert.ok(result.text.includes('significant changes detected'));
    });

    it('first call with no prev returns full', () => {
      // This is handled by processSnapshot, not computeDiff directly
      // But verify computeDiff handles empty prev gracefully
      const result = computeDiff('', 'line1\nline2');
      assert.ok(result.changeRate > 0);
    });
  });
});
