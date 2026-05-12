/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function createIdGenerator() {
  let i = 1;
  return () => {
    if (i === Number.MAX_SAFE_INTEGER) {
      i = 0;
    }
    return i++;
  };
}

export const stableIdSymbol = Symbol('stableIdSymbol');

/**
 * Wall-clock epoch milliseconds at which an item was inserted into a
 * `PageCollector` chunk. Stamped lazily so consumers (`list_console_messages`,
 * `list_network_requests`) can apply `since` filters without changing the
 * underlying buffer storage layout. (FR-004)
 */
export const collectedAtSymbol = Symbol('collectedAtSymbol');

/**
 * Marker stamped on records whose estimated size exceeds the configured
 * `recordSizeCapBytes` (FR-005). The original Puppeteer object is left
 * untouched; consumers (formatters, tool responses) read the symbol to surface
 * a `truncated: true` hint to clients.
 */
export const oversizeSymbol = Symbol('oversizeSymbol');

export type WithSymbolId<T> = T & {
  [stableIdSymbol]?: number;
  [collectedAtSymbol]?: number;
  [oversizeSymbol]?: boolean;
};
