#!/usr/bin/env node
// claude.mjs, a REFERENCE read-only memory provider: your project's Claude Code memory (CLAUDE.md,
// AGENTS.md, and top-level .claude/*.md) as a recall source. It is the most UBIQUITOUS local memory -
// a Claude Code repo already has it - so it is zero-setup. READ-ONLY by design: recall only; debt and
// record EXIT NONZERO (unsupported). This is a view of memory you already keep, not a write target
// (writing findings into CLAUDE.md would bloat the always-loaded project context), and the contract
// lets a provider implement a subset. Inherently leaf-scoped (reads only this repo's files, so no
// cross-repo leak). Zero-dep, offline, local-notes axis.
//
//   recall --file P [--file Q] --json   relevant lines from your project memory -> Finding[] (kind note)
//   debt | record                        EXIT NONZERO (unsupported)

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flagAll = (n) => argv.reduce((a, v, i) => (argv[i - 1] === n ? [...a, v] : a), []);
const die = (m, c = 2) => { process.stderr.write(`claude provider: ${m}\n`); process.exit(c); };
const CWD = process.cwd();

if (cmd === 'debt' || cmd === 'record') die(`${cmd} is unsupported (claude memory is a read-only recall source)`, 2);

if (cmd === 'recall') {
  const paths = flagAll('--file');
  if (!paths.length) { console.log('[]'); process.exit(0); }
  const matches = (l) => paths.find((p) => l.includes(p) || (basename(p).length > 2 && l.includes(basename(p)))) || null;
  // the project's Claude Code memory: CLAUDE.md / AGENTS.md at the root, plus top-level .claude/*.md.
  const sources = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) { const p = join(CWD, f); if (existsSync(p)) sources.push(p); }
  try { for (const e of readdirSync(join(CWD, '.claude'))) if (extname(e).toLowerCase() === '.md') sources.push(join(CWD, '.claude', e)); } catch {}
  const out = [];
  for (const src of sources) {
    let text = ''; try { if (statSync(src).size > 512 * 1024) continue; text = readFileSync(src, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    let heading = basename(src);
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^#{1,6}\s+(.+)/);
      if (h) { heading = h[1].trim(); continue; }
      const hit = matches(lines[i]);
      if (!hit) continue;
      out.push({ kind: 'note', path: hit, ref: `${basename(src)}:${i + 1}`, date: null, summary: `${heading}: ${lines[i].trim()}`.slice(0, 280), score: 0.4 });
    }
  }
  console.log(JSON.stringify(out.slice(0, 8)));
  process.exit(0);
}

die(`unknown command '${cmd || ''}' (recall | debt | record)`, 2);
