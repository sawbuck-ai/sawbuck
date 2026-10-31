#!/usr/bin/env node
// dispatch.mjs, the dispatch: a compact proof-of-work receipt from the results.
// A receipt, not an ad. Silent when nothing's been recorded to show (unless --force).
// Zero-dep. Usage: node dispatch.mjs [--repo <path>] [--force] [--json]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? (process.argv[i + 1] ?? true) : d; };
const repo = flag('--repo', process.cwd());
const force = process.argv.includes('--force');

let rec = null;
try { rec = JSON.parse(readFileSync(join(repo, '.sawbuck', 'results.json'), 'utf8')); } catch {}

const total = rec ? (rec.regressions || 0) + (rec.gamed || 0) : 0;
if (!rec || (!total && !force)) process.exit(0);          // nothing recorded → stay quiet
if (process.argv.includes('--json')) { console.log(JSON.stringify(rec)); process.exit(0); }

const n = (x, s) => `${x} ${s}${x === 1 ? '' : 's'}`;
const parts = ['Sawbuck', `${n(rec.regressions || 0, 'regression')} charted`];
if (rec.gamed) parts.push(`${n(rec.gamed, 'gamed change')} caught`);
let line = parts.join('  ·  ');
if (rec.latest) line += `\n   🆕 just learned: ${rec.latest.reason || rec.latest.kind} (${rec.latest.file})`;
console.log(line);
