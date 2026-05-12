/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * ChunkBuffer — bounded buffer for one navigation segment of a PageCollector.
 * Wraps RingBuffer with helpers needed for navigation split (NetworkCollector
 * carries the latest navigation request and its descendants into the new
 * chunk on `framenavigated`).
 *
 * See specs/001-stability-hardening/plan.md WP-1 + tasks.md T016.
 */

import {RingBuffer} from './ringBuffer.js';

export interface ChunkMeta {
  size: number;
  totalPushed: number;
  evicted: number;
}

export class ChunkBuffer<T> {
  readonly capacity: number;
  #buffer: RingBuffer<T>;
  // Historical counters survive replaceItems() so split semantics don't lose
  // the chunk's lifetime push/eviction history.
  #historicalEvicted = 0;
  #historicalPushed = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.#buffer = new RingBuffer<T>(capacity);
  }

  push(item: T): void {
    this.#buffer.push(item);
  }

  get size(): number {
    return this.#buffer.size;
  }

  get totalPushed(): number {
    return this.#historicalPushed + this.#buffer.totalPushed;
  }

  get evicted(): number {
    return this.#historicalEvicted + this.#buffer.evicted;
  }

  toArray(): T[] {
    return this.#buffer.toArray();
  }

  forEach(cb: (item: T, index: number) => void): void {
    this.#buffer.forEach(cb);
  }

  meta(): ChunkMeta {
    return {
      size: this.size,
      totalPushed: this.totalPushed,
      evicted: this.evicted,
    };
  }

  /**
   * Replace current contents with the given items, preserving historical
   * counters. Used when a navigation split needs to carve a chunk into
   * "kept" + "carried over" parts without losing eviction history.
   */
  replaceItems(items: readonly T[]): void {
    this.#historicalEvicted += this.#buffer.evicted;
    this.#historicalPushed += this.#buffer.totalPushed;
    this.#buffer = new RingBuffer<T>(this.capacity);
    for (const item of items) {
      this.#buffer.push(item);
    }
    // Items re-added during replace shouldn't double-count as fresh pushes,
    // so subtract them from historical (their history is captured by being
    // re-inserted now).
    this.#historicalPushed -= items.length;
  }
}
