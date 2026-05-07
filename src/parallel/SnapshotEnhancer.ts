/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * SnapshotEnhancer: denoises accessibility snapshots, computes diffs,
 * collects CDP field states, and detects page state.
 * See specs/001-parallel-instances/tasks.md T052.
 *
 * Entrypoint: `process()` — returns canonical (for prev) and enhanced text.
 */

import type {Page} from '../third_party/index.js';

// ---------- Denoise ----------

/** Lines that add noise and no semantic value (excluding blank lines) */
const NOISE_PATTERNS: RegExp[] = [/^\s*generic\s*$/i, /^\s*InlineTextBox\s*$/i];

/**
 * Remove noise lines from snapshot text and collapse consecutive blanks.
 * Exported for unit testing.
 */
export function denoise(text: string): string {
  const lines = text.split('\n');
  const filtered: string[] = [];
  for (const line of lines) {
    let isNoise = false;
    for (const pattern of NOISE_PATTERNS) {
      if (pattern.test(line)) {
        isNoise = true;
        break;
      }
    }
    if (!isNoise) {
      filtered.push(line);
    }
  }
  // Collapse consecutive blank lines to one
  const collapsed: string[] = [];
  let prevBlank = false;
  for (const line of filtered) {
    if (line.trim().length === 0) {
      if (!prevBlank) {
        collapsed.push('');
        prevBlank = true;
      }
    } else {
      collapsed.push(line);
      prevBlank = false;
    }
  }
  return collapsed.join('\n');
}

// ---------- Diff ----------

const DIFF_THRESHOLD = 0.35;
const CONTEXT_LINES = 3;

export interface DiffResult {
  isDiff: boolean;
  changeRate: number;
  text: string;
}

/**
 * Compute line-level diff between prev and current.
 * If change rate ≤ 35%, output diff-only with context.
 * If > 35%, output full text with "significant changes detected".
 */
export function computeDiff(prev: string, current: string): DiffResult {
  const prevLines = prev.split('\n');
  const currentLines = current.split('\n');

  // Simple set-based diff (O(n))
  const prevSet = new Set(prevLines);
  const currentSet = new Set(currentLines);

  let added = 0;
  let removed = 0;

  for (const line of currentLines) {
    if (!prevSet.has(line)) {
      added++;
    }
  }
  for (const line of prevLines) {
    if (!currentSet.has(line)) {
      removed++;
    }
  }

  const totalLines = Math.max(prevLines.length, currentLines.length, 1);
  const changedLines = Math.max(added, removed);
  const changeRate = changedLines / totalLines;

  if (changeRate > DIFF_THRESHOLD) {
    // Full output
    return {
      isDiff: false,
      changeRate,
      text:
        current +
        `\n\n[snapshot full, significant changes detected: ${changedLines} lines changed out of ${totalLines} (${Math.round(changeRate * 100)}%)]`,
    };
  }

  // Build diff-only output with context
  const diffLines: string[] = [];
  const currentMap = new Map<string, number[]>();
  for (let i = 0; i < currentLines.length; i++) {
    const arr = currentMap.get(currentLines[i]) ?? [];
    arr.push(i);
    currentMap.set(currentLines[i], arr);
  }

  // Mark changed line indices in current
  const changedIndices = new Set<number>();
  for (let i = 0; i < currentLines.length; i++) {
    if (!prevSet.has(currentLines[i])) {
      changedIndices.add(i);
    }
  }

  // Include context around changed lines
  const includeIndices = new Set<number>();
  for (const idx of changedIndices) {
    for (
      let c = Math.max(0, idx - CONTEXT_LINES);
      c <= Math.min(currentLines.length - 1, idx + CONTEXT_LINES);
      c++
    ) {
      includeIndices.add(c);
    }
  }

  let lastIncluded = -2;
  for (let i = 0; i < currentLines.length; i++) {
    if (!includeIndices.has(i)) {
      continue;
    }
    if (i > lastIncluded + 1) {
      diffLines.push('...');
    }
    const prefix = changedIndices.has(i) ? '+ ' : '  ';
    diffLines.push(`${prefix}${currentLines[i]}`);
    lastIncluded = i;
  }

  // Also show removed lines
  for (const line of prevLines) {
    if (!currentSet.has(line)) {
      diffLines.push(`- ${line}`);
    }
  }

  const summary = `[snapshot diff, ${changedLines} lines changed out of ${totalLines} (${Math.round(changeRate * 100)}%)]`;
  return {
    isDiff: true,
    changeRate,
    text: diffLines.join('\n') + '\n\n' + summary,
  };
}

// ---------- Page State ----------

export type PageState = 'error' | 'loading' | 'normal';

/**
 * Detect page state: error > loading > normal.
 */
export async function detectPageState(page: Page): Promise<PageState> {
  try {
    const url = page.url();
    if (url.startsWith('chrome-error://')) {
      return 'error';
    }

    // Check HTTP status via evaluate
    const readyState = await page.evaluate(() => document.readyState);
    if (readyState !== 'complete') {
      return 'loading';
    }

    return 'normal';
  } catch {
    return 'error';
  }
}

// ---------- Field States (CDP) ----------

export interface FieldState {
  selector: string;
  value: string;
  type: string;
}

/**
 * Collect field states from interactive elements via CDP.
 * Best-effort: failures silently return empty array.
 */
export async function collectFieldStates(page: Page): Promise<FieldState[]> {
  try {
    const fields = await page.evaluate(() => {
      const results: Array<{selector: string; value: string; type: string}> =
        [];
      const inputs = document.querySelectorAll(
        'input, select, textarea, [contenteditable="true"]',
      );
      for (const el of inputs) {
        let selector = el.tagName.toLowerCase();
        const id = el.getAttribute('id');
        const name = el.getAttribute('name');
        if (id) {
          selector = `#${id}`;
        } else if (name) {
          selector = `${el.tagName.toLowerCase()}[name="${name}"]`;
        }

        let value = '';
        let type = 'text';

        if (el.tagName === 'SELECT') {
          const selectEl = el as unknown as HTMLSelectElement;
          value = selectEl.value;
          type = 'select';
        } else if (el.tagName === 'TEXTAREA') {
          value = (el as unknown as HTMLTextAreaElement).value;
          type = 'textarea';
        } else if (el.tagName === 'INPUT') {
          const inputEl = el as unknown as HTMLInputElement;
          type = inputEl.type || 'text';
          if (type === 'checkbox' || type === 'radio') {
            value = inputEl.checked ? 'checked' : 'unchecked';
          } else {
            value = inputEl.value;
          }
        } else {
          // contenteditable
          value = el.textContent ?? '';
          type = 'contenteditable';
        }

        results.push({selector, value, type});
      }
      return results;
    });
    return fields;
  } catch {
    return [];
  }
}

// ---------- Main Process ----------

export interface SnapshotEnhancerInput {
  text: string;
  prev: string | null;
  prevOrigin: string | null;
  page: Page;
  currentOrigin: string;
}

export interface SnapshotEnhancerOutput {
  /** Display text (may be diff + enhancements) */
  text: string;
  /** Canonical text stored as next prev (denoised, no enhancements) */
  canonical: string;
  /** Current origin stored for next comparison */
  origin: string;
}

/**
 * Main entrypoint: process a snapshot with denoise, diff, field states, page state.
 */
export async function processSnapshot(
  input: SnapshotEnhancerInput,
): Promise<SnapshotEnhancerOutput> {
  const {text, prev, prevOrigin, page, currentOrigin} = input;

  // Step 1: Denoise
  const canonical = denoise(text);

  // Step 2: Page state
  const pageState = await detectPageState(page);
  const pageStateTag = `[pageState: ${pageState}]`;

  // Step 3: Field states
  let fieldStatesSection = '';
  if (pageState === 'normal') {
    const fields = await collectFieldStates(page);
    if (fields.length > 0) {
      const fieldLines = fields.map(
        f => `  ${f.selector} (${f.type}): "${f.value}"`,
      );
      fieldStatesSection = '\n\n[CDP Field States]\n' + fieldLines.join('\n');
    }
  }

  // Step 4: Diff (only if same origin and prev exists)
  let displayText: string;
  const originChanged = prevOrigin !== null && prevOrigin !== currentOrigin;

  if (prev === null || originChanged) {
    // First call or origin switch → full output
    displayText = canonical;
    if (originChanged) {
      displayText += '\n\n[origin changed, full snapshot]';
    }
  } else {
    // Compute diff
    const diff = computeDiff(prev, canonical);
    displayText = diff.text;
  }

  // Combine
  const finalText = pageStateTag + '\n' + displayText + fieldStatesSection;

  return {
    text: finalText,
    canonical,
    origin: currentOrigin,
  };
}
