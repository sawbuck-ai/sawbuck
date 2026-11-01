#!/usr/bin/env node
// local.mjs, a REFERENCE minimal local-file memory provider: the simplest way to fill the socket with
// no external tool. Findings live as JSON in <repo>/.sawbuck/memory-notes.json (git-excluded by attach).
// It is the cleanest conformance target and a "bring your own, just a file" option. Zero-dep, offline,
// in the local-notes axis alongside obsidian. Folder-scoped like the others.
//
//   recall --file P [--scope ID ...] --json   -> Finding[] (kind note)
//   record --ref SHA --summary S [--scope ID] [--side X] [--evidence-file F] --by WHO
//   debt   --json                              EXITS NONZERO (a note store is not git-aware)
//
// Store: SAWBUCK_LOCAL_MEMORY, else <cwd>/.sawbuck/memory-notes.json.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flagAll = (n) => argv.reduce((a, v, i) => (argv[i - 1] === n ? [...a, v] : a), []);
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? (argv[i + 1] ?? true) : d; };
const die = (m, c = 2) => { process.stderr.write(`local provider: ${m}\n`); process.exit(c); };

const STORE = process.env.SAWBUCK_LOCAL_MEMORY || join(process.cwd(), '.sawbuck', 'memory-notes.json');
const load = () => { try { const v = JSON.parse(readFileSync(STORE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; } };

if (cmd === 'debt') die('debt is unsupported by a note store (git-truth lives in a git provider like logbook)', 2);

if (cmd === 'recall') {
  const paths = flagAll('--file');
  if (!paths.length) { console.log('[]'); process.exit(0); }
  const scopes = new Set(flagAll('--scope'));            // self + ancestors; empty (direct call) = match any
  const bases = paths.map((p) => basename(p));
  const out = [];
  for (const f of load()) {
    if (scopes.size && f.scope != null && !scopes.has(f.scope)) continue;   // isolation: a sibling scope is excluded
    const hit = (f.path && paths.includes(f.path)) || (f.summary && bases.some((b) => f.summary.includes(b)));
    if (!hit) continue;
    out.push({ kind: 'note', path: f.path ?? null, ref: f.ref ?? null, date: f.date ?? null, summary: String(f.summary || '').slice(0, 280), scope: f.scope ?? '', score: 0.5 });
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  console.log(JSON.stringify(out.slice(0, 8)));
  process.exit(0);
}

if (cmd === 'record') {
  const ref = String(flag('--ref', '')), summary = String(flag('--summary', '')), by = String(flag('--by', 'sawbuck'));
  const scope = flagAll('--scope')[0] ?? '';
  const side = flag('--side', ''), evidence = flag('--evidence-file', '');
  const notes = load();
  if (notes.some((f) => f.ref === ref && f.summary === summary && f.scope === scope)) { console.log('recorded (already present)'); process.exit(0); }
  notes.push({ ref, summary, path: evidence || null, scope, by, ...(side ? { side: String(side) } : {}), date: new Date().toISOString().slice(0, 10) });
  try { mkdirSync(dirname(STORE), { recursive: true }); writeFileSync(STORE, JSON.stringify(notes, null, 2) + '\n'); console.log('recorded'); process.exit(0); }
  catch (e) { die(`write failed: ${String(e.message).split('\n')[0]}`, 1); }
}

die(`unknown command '${cmd || ''}' (recall | debt | record)`, 2);
