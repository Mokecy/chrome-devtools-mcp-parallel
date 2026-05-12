/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bounded FIFO ring buffer for stability hardening (FR-001..005).
 * Implementation uses a fixed-size backing array with head index moved by
 * modular arithmetic. `Array.shift()` is intentionally NOT used — its O(n)
 * cost would defeat the buffer cap during high-frequency writes.
 *
 * See specs/001-stability-hardening/plan.md WP-1 + tasks.md T009.
 */

export class RingBuffer<T> {
  readonly #capacity: number;
  readonly #buffer: Array<T | undefined>;
  #head = 0;
  #size = 0;
  #totalPushed = 0;
  #evicted = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `RingBuffer capacity must be a positive integer, got ${capacity}`,
      );
    }
    this.#capacity = capacity;
    this.#buffer = new Array<T | undefined>(capacity);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#size;
  }

  get totalPushed(): number {
    return this.#totalPushed;
  }

  get evicted(): number {
    return this.#evicted;
  }

  push(item: T): void {
    this.#totalPushed++;
    if (this.#size < this.#capacity) {
      const tail = (this.#head + this.#size) % this.#capacity;
      this.#buffer[tail] = item;
      this.#size++;
      return;
    }
    // Full: overwrite slot at head, advance head, increment evicted.
    this.#buffer[this.#head] = item;
    this.#head = (this.#head + 1) % this.#capacity;
    this.#evicted++;
  }

  /**
   * Returns items in oldest-to-newest order.
   */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.#size; i++) {
      const idx = (this.#head + i) % this.#capacity;
      const value = this.#buffer[idx];
      if (value !== undefined) {
        out.push(value);
      }
    }
    return out;
  }

  forEach(cb: (item: T, index: number) => void): void {
    for (let i = 0; i < this.#size; i++) {
      const idx = (this.#head + i) % this.#capacity;
      const value = this.#buffer[idx];
      if (value !== undefined) {
        cb(value, i);
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.#capacity; i++) {
      this.#buffer[i] = undefined;
    }
    this.#head = 0;
    this.#size = 0;
    // totalPushed / evicted intentionally preserved as historical counters.
  }
}
