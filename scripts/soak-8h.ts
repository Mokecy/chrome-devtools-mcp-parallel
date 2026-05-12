/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T084 — manual 8h soak driver for SC-001.
 *
 * Spawns the bundled parallel MCP server over stdio, creates a single
 * launch-mode instance, then drives ~5 console + ~5 network events / sec
 * via `page_evaluate_script` for the configured duration. Every minute
 * it polls `system_observe` and prints a single-line metric snapshot.
 *
 * Pass criteria (acceptance for SC-001 / SC-008):
 *   - process survives the full duration with no crashes / disconnects
 *   - RSS growth (final − baseline) < 200 MB across an 8h run
 *   - both `console` and `network` buffers report `evicted > 0`
 *
 * Usage:
 *   npm run build
 *   npm run soak-8h                       # default 8h
 *   SOAK_HOURS=2 npm run soak-8h          # shorter run
 *   SOAK_LOG_FILE=./soak.log npm run soak-8h
 *
 * Output:
 *   - one METRIC line per minute on stdout (also tee'd to SOAK_LOG_FILE)
 *   - final SUMMARY block (peak RSS / total evicted / instance state)
 *
 * Not wired into CI — this is a manual long-runner.
 */

import {spawn, type ChildProcessByStdio} from 'node:child_process';
import {appendFileSync, openSync, writeSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type {Readable, Writable} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';

const SERVER = path.resolve('build/src/bin/chrome-devtools-mcp-parallel.js');
const SERVER_ARGS = [
  '--headless',
  '--isolated',
  '--max-instances',
  '1',
  // Tighten buffers so eviction is observable inside any non-trivial
  // soak window.
  '--console-buffer-size',
  '500',
  '--network-buffer-size',
  '1000',
];

const SOAK_HOURS = Number(process.env['SOAK_HOURS'] ?? '8');
const TICK_INTERVAL_MS = Number(process.env['SOAK_TICK_INTERVAL_MS'] ?? '200');
const METRIC_INTERVAL_MS = Number(
  process.env['SOAK_METRIC_INTERVAL_MS'] ?? `${60 * 1000}`,
);
const LOG_FILE = process.env['SOAK_LOG_FILE'];

if (!Number.isFinite(SOAK_HOURS) || SOAK_HOURS <= 0) {
  console.error(`SOAK_HOURS must be a positive number, got: ${SOAK_HOURS}`);
  process.exit(2);
}

const totalDurationMs = SOAK_HOURS * 60 * 60 * 1000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface RpcResult {
  content?: Array<{type: string; text?: string}>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Snapshot {
  ts: string;
  memory: {rssMb: number; heapUsedMb: number; heapPct: number};
  instances: Array<{
    id: string;
    state: string;
    console: {retained: number; evicted: number; totalPushed: number};
    network: {retained: number; evicted: number; totalPushed: number};
  }>;
  artifactDir: {ephemeralBytes: number; persistentBytes: number};
}

let nextRpcId = 1;
const pending = new Map<number, PendingCall>();

let logFd: number | undefined;
if (LOG_FILE) {
  logFd = openSync(LOG_FILE, 'a');
}

function logLine(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  process.stdout.write(`${stamped}\n`);
  if (logFd !== undefined) {
    writeSync(logFd, `${stamped}\n`);
  }
}

function rpc(
  proc: ChildProcessByStdio<Writable, Readable, Readable>,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<unknown> {
  const id = nextRpcId++;
  const payload = {jsonrpc: '2.0', id, method, params};
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, {resolve, reject});
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, timeoutMs);
    timer.unref();
  });
}

function notify(
  proc: ChildProcessByStdio<Writable, Readable, Readable>,
  method: string,
  params: Record<string, unknown> = {},
): void {
  proc.stdin.write(
    `${JSON.stringify({jsonrpc: '2.0', method, params})}\n`,
  );
}

function isRpcResult(value: unknown): value is RpcResult {
  return typeof value === 'object' && value !== null;
}

function extractStructured(result: unknown): Record<string, unknown> {
  if (!isRpcResult(result)) {
    return {};
  }
  const sc = result.structuredContent;
  return typeof sc === 'object' && sc !== null ? sc : {};
}

function extractText(result: unknown): string {
  if (!isRpcResult(result) || !Array.isArray(result.content)) {
    return '';
  }
  for (const item of result.content) {
    if (item.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return '';
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  // Copy keys into a fresh Record so the return type is provable without
  // a `as` cast.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = v;
  }
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseInstance(raw: unknown): Snapshot['instances'][number] | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = asObject(raw);
  const consoleObj = asObject(obj['console']);
  const networkObj = asObject(obj['network']);
  return {
    id: asString(obj['id']),
    state: asString(obj['state'], 'unknown'),
    console: {
      retained: asNumber(consoleObj['retained']),
      evicted: asNumber(consoleObj['evicted']),
      totalPushed: asNumber(consoleObj['totalPushed']),
    },
    network: {
      retained: asNumber(networkObj['retained']),
      evicted: asNumber(networkObj['evicted']),
      totalPushed: asNumber(networkObj['totalPushed']),
    },
  };
}

function parseSnapshot(structured: Record<string, unknown>): Snapshot | null {
  const ts = structured['ts'];
  const memory = structured['memory'];
  const instancesRaw = structured['instances'];
  const artifactDir = structured['artifactDir'];
  if (
    typeof ts !== 'string' ||
    typeof memory !== 'object' ||
    memory === null ||
    !Array.isArray(instancesRaw) ||
    typeof artifactDir !== 'object' ||
    artifactDir === null
  ) {
    return null;
  }
  const memoryObj = asObject(memory);
  const artifactObj = asObject(artifactDir);
  const instances: Snapshot['instances'] = [];
  for (const item of instancesRaw) {
    const parsed = parseInstance(item);
    if (parsed) {
      instances.push(parsed);
    }
  }
  return {
    ts,
    memory: {
      rssMb: asNumber(memoryObj['rssMb']),
      heapUsedMb: asNumber(memoryObj['heapUsedMb']),
      heapPct: asNumber(memoryObj['heapPct']),
    },
    instances,
    artifactDir: {
      ephemeralBytes: asNumber(artifactObj['ephemeralBytes']),
      persistentBytes: asNumber(artifactObj['persistentBytes']),
    },
  };
}

function setupStdoutDispatch(
  proc: ChildProcessByStdio<Writable, Readable, Readable>,
): void {
  let buf = '';
  proc.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let newline = buf.indexOf('\n');
    while (newline !== -1) {
      const line = buf.slice(0, newline).trim();
      buf = buf.slice(newline + 1);
      newline = buf.indexOf('\n');
      if (!line) {
        continue;
      }
      try {
        const msgRaw: unknown = JSON.parse(line);
        const msg = asObject(msgRaw);
        const id = msg['id'];
        if (typeof id === 'number' && pending.has(id)) {
          const handler = pending.get(id);
          pending.delete(id);
          if (handler) {
            const errField = msg['error'];
            if (errField !== undefined && errField !== null) {
              const errObj = asObject(errField);
              const errMsg = asString(errObj['message']);
              handler.reject(
                new Error(
                  `RPC error: ${errMsg !== '' ? errMsg : JSON.stringify(errField)}`,
                ),
              );
            } else {
              handler.resolve(msg['result']);
            }
          }
        }
      } catch {
        // Non-JSON lines come from server logging passthrough; ignore.
      }
    }
  });
}

async function main(): Promise<void> {
  const baselineRss = process.memoryUsage().rss;
  logLine(
    `START soak duration=${SOAK_HOURS}h tickIntervalMs=${TICK_INTERVAL_MS} metricIntervalMs=${METRIC_INTERVAL_MS} baselineRssMb=${(
      baselineRss /
      (1024 * 1024)
    ).toFixed(1)}`,
  );

  const proc = spawn(process.execPath, [SERVER, ...SERVER_ARGS], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  proc.stderr.on('data', chunk => {
    stderrTail += chunk.toString('utf8');
    if (stderrTail.length > 64 * 1024) {
      stderrTail = stderrTail.slice(-32 * 1024);
    }
  });

  proc.on('exit', code => {
    logLine(`server exited code=${code}`);
  });

  setupStdoutDispatch(proc);

  await rpc(proc, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {name: 'soak-8h', version: '1'},
  });
  notify(proc, 'notifications/initialized');

  await rpc(proc, 'tools/call', {
    name: 'instance_create',
    arguments: {instanceId: 'soak'},
  });

  await rpc(proc, 'tools/call', {
    name: 'page_navigate_page',
    arguments: {instanceId: 'soak', url: 'about:blank'},
  });

  let peakRssMb = 0;
  let lastConsoleEvicted = 0;
  let lastNetworkEvicted = 0;
  let lastInstanceState = 'unknown';

  const startedAt = Date.now();
  const deadline = startedAt + totalDurationMs;
  let lastMetricAt = startedAt;
  let tickSeq = 0;

  // Drive load + emit periodic METRIC lines.
  while (Date.now() < deadline) {
    // Emit 1 console + 1 fetch per tick.
    try {
      await rpc(
        proc,
        'tools/call',
        {
          name: 'page_evaluate_script',
          arguments: {
            instanceId: 'soak',
            function: `(seq) => { console.log('soak-' + seq); fetch('/__soak/' + seq).catch(() => {}); }`,
            args: [{value: tickSeq}],
          },
        },
        15_000,
      );
    } catch (err) {
      logLine(`tick ${tickSeq} failed: ${errMessage(err)}`);
    }
    tickSeq++;

    if (Date.now() - lastMetricAt >= METRIC_INTERVAL_MS) {
      lastMetricAt = Date.now();
      try {
        const obs = await rpc(
          proc,
          'tools/call',
          {name: 'system_observe', arguments: {}},
          15_000,
        );
        const snap = parseSnapshot(extractStructured(obs));
        if (snap) {
          peakRssMb = Math.max(peakRssMb, snap.memory.rssMb);
          const inst = snap.instances[0];
          if (inst) {
            lastConsoleEvicted = inst.console.evicted;
            lastNetworkEvicted = inst.network.evicted;
            lastInstanceState = inst.state;
          }
          logLine(
            `METRIC elapsedMin=${(
              (Date.now() - startedAt) /
              60_000
            ).toFixed(1)} rssMb=${snap.memory.rssMb.toFixed(1)} heapPct=${(
              snap.memory.heapPct * 100
            ).toFixed(1)} state=${lastInstanceState} consoleEvicted=${lastConsoleEvicted} networkEvicted=${lastNetworkEvicted} ticks=${tickSeq}`,
          );
        } else {
          logLine(
            `METRIC parse-failed text="${extractText(obs).slice(0, 120)}"`,
          );
        }
      } catch (err) {
        logLine(`system_observe failed: ${errMessage(err)}`);
      }
    }

    await sleep(TICK_INTERVAL_MS);
  }

  // Final snapshot.
  let finalSnapshot: Snapshot | null = null;
  try {
    const obs = await rpc(proc, 'tools/call', {
      name: 'system_observe',
      arguments: {includeMemorySamples: true},
    });
    finalSnapshot = parseSnapshot(extractStructured(obs));
  } catch (err) {
    logLine(`final system_observe failed: ${errMessage(err)}`);
  }

  await rpc(proc, 'tools/call', {
    name: 'instance_close',
    arguments: {instanceId: 'soak'},
  });

  proc.stdin.end();
  await sleep(500);
  if (!proc.killed) {
    proc.kill();
  }

  const finalRssMb =
    finalSnapshot?.memory.rssMb ?? process.memoryUsage().rss / (1024 * 1024);
  const baselineRssMb = baselineRss / (1024 * 1024);
  const growthMb = finalRssMb - baselineRssMb;

  const summary = [
    'SUMMARY',
    `  durationHours=${SOAK_HOURS}`,
    `  totalTicks=${tickSeq}`,
    `  baselineRssMb=${baselineRssMb.toFixed(1)}`,
    `  finalRssMb=${finalRssMb.toFixed(1)}`,
    `  peakRssMb=${peakRssMb.toFixed(1)}`,
    `  rssGrowthMb=${growthMb.toFixed(1)} (budget=200)`,
    `  consoleEvicted=${lastConsoleEvicted}`,
    `  networkEvicted=${lastNetworkEvicted}`,
    `  instanceState=${lastInstanceState}`,
  ].join('\n');

  if (LOG_FILE) {
    appendFileSync(LOG_FILE, `${summary}\n`);
  }
  process.stdout.write(`${summary}\n`);

  if (stderrTail) {
    process.stderr.write(`--- server stderr tail ---\n${stderrTail}\n`);
  }

  // Exit code reflects the SC-001 acceptance gate.
  const passed =
    growthMb < 200 &&
    lastConsoleEvicted > 0 &&
    lastNetworkEvicted > 0 &&
    lastInstanceState !== 'dead';
  process.exit(passed ? 0 : 1);
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    logLine(`FATAL ${err.stack ?? err.message}`);
  } else {
    logLine(`FATAL ${String(err)}`);
  }
  process.exit(2);
});
