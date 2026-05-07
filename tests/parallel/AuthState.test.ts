/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for AuthStateHolder.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {AuthStateHolder} from '../../src/parallel/AuthState.js';

describe('AuthStateHolder', () => {
  it('starts as null', () => {
    const holder = new AuthStateHolder();
    assert.equal(holder.get(), null);
    assert.equal(holder.summary(), null);
  });

  it('set() stores frozen state', () => {
    const holder = new AuthStateHolder();
    const state = holder.set(
      [
        {
          name: 'sid',
          value: '123',
          domain: '.example.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      [{origin: 'https://example.com', items: [['key', 'val']]}],
      'browser_connect',
    );
    assert.equal(state.cookies.length, 1);
    assert.equal(state.origins.length, 1);
    assert.equal(state.capturedFrom, 'browser_connect');
    assert.ok(state.capturedAt instanceof Date);
    // Frozen
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.isFrozen(state.cookies));
  });

  it('set() replaces previous state atomically', () => {
    const holder = new AuthStateHolder();
    const first = holder.set([], [], 'browser_connect');
    const second = holder.set(
      [
        {
          name: 'a',
          value: 'b',
          domain: '.x.com',
          path: '/',
          expires: 100,
          httpOnly: false,
          secure: false,
          sameSite: undefined,
        },
      ],
      [],
      'instance_export_auth',
    );
    assert.notEqual(first, second);
    assert.equal(holder.get(), second);
  });

  it('clear() removes state', () => {
    const holder = new AuthStateHolder();
    holder.set([], [], 'browser_connect');
    holder.clear();
    assert.equal(holder.get(), null);
  });

  it('summary() returns count string', () => {
    const holder = new AuthStateHolder();
    holder.set(
      [
        {
          name: 'a',
          value: '1',
          domain: '.x.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: undefined,
        },
        {
          name: 'b',
          value: '2',
          domain: '.y.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: undefined,
        },
      ],
      [{origin: 'https://x.com', items: [['k', 'v']]}],
      'browser_connect',
    );
    assert.equal(holder.summary(), '2 cookies, 1 origins with localStorage');
  });
});
