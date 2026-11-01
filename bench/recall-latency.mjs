#!/usr/bin/env node
// recall-latency.mjs, a bench for the memory socket's `recall` path: is a note provider fast enough to
// sit on the per-turn path, or must it stay on-demand? NOT shipped (dev tool, not in package `files`).
// Measures the obsidian provider locally over a synthetic vault; measures mem0 only if MEM0_API_KEY is
// set (a live network call), else skips it. Zero-dep.
//
//   node bench/recall-latency.mjs [--notes N] [--runs M]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSIDIAN = join(HERE, '..', 'providers', 'obsidian.mjs');
const MEM0 = join(HERE, '..', 'providers', 'mem0.mjs');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const NOTES = arg('--notes', 500);
const RUNS = arg('--runs', 20);
const TARGET = 'src/session/store.js';

const stats = (ms) => { const s = [...ms].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], min: s[0], max: s[s.length - 1] }; };
const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };

// a synthetic vault shaped like a real project tree: a shared root + several sibling repos, NOTES
// notes spread across them, a fraction mentioning TARGET so recall has real matches to rank.
const V = mkdtempSync(join(tmpdir(), 'sawbuck-bench-vault-'));
const repos = ['repoA', 'repoB', 'repoC', 'group/repoD'];
for (const r of repos) mkdirSync(join(V, r), { recursive: true });
const folders = ['', ...repos];
for (let i = 0; i < NOTES; i++) {
  const f = folders[i % folders.length];
  const mentions = i % 4 === 0 ? `\nThe retry logic in ${TARGET} is subtle; keep the backoff.\n` : '';
  writeFileSync(join(V, f, `note-${i}.md`), `# Note ${i}\n\nSome project knowledge number ${i}.${mentions}\n`);
}

const obsidianRun = () => execFileSync(process.execPath, [OBSIDIAN, 'recall', '--file', TARGET, '--scope', 'repoA', '--scope', '', '--json'], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_VAULT: V } });

try {
  obsidianRun(); // warm
  const obs = []; for (let i = 0; i < RUNS; i++) obs.push(time(obsidianRun));
  const o = stats(obs);
  const hits = JSON.parse(obsidianRun()).length;
  console.log(`recall-latency  (vault: ${NOTES} notes across ${repos.length + 1} scopes, ${RUNS} runs)`);
  console.log(`  obsidian (local):  median ${o.median.toFixed(1)}ms  p95 ${o.p95.toFixed(1)}ms  (min ${o.min.toFixed(1)} / max ${o.max.toFixed(1)}); ${hits} hits`);
  console.log(`    per-turn viable (< ~150ms)? ${o.p95 < 150 ? 'YES' : 'borderline/no, keep on-demand'}`);

  if (process.env.MEM0_API_KEY) {
    const mem0Run = () => execFileSync(process.execPath, [MEM0, 'recall', '--file', TARGET, '--scope', 'repoA', '--scope', '', '--json'], { encoding: 'utf8' });
    mem0Run();
    const m = []; for (let i = 0; i < Math.min(RUNS, 5); i++) m.push(time(mem0Run));
    const ms = stats(m);
    console.log(`  mem0 (network):    median ${ms.median.toFixed(1)}ms  p95 ${ms.p95.toFixed(1)}ms  (live API)`);
    console.log(`    per-turn viable? ${ms.p95 < 150 ? 'YES' : 'NO, on-demand only (a network hop per turn is too slow)'}`);
  } else {
    console.log('  mem0 (network):    skipped (set MEM0_API_KEY to measure the live search; a network hop is expected to be on-demand only)');
  }
} finally { rmSync(V, { recursive: true, force: true }); }
