#!/usr/bin/env node
// obsidian.mjs, a REFERENCE memory provider for Sawbuck's Memory Contract: an Obsidian vault as the
// memory. It shows how to fill the socket, and it is the second implementation the contract is
// designed against. Zero-dep. Opt in with SAWBUCK_MEMORY=logbook,obsidian and OBSIDIAN_VAULT=/path/to/vault
// (compose it WITH logbook: logbook stays the git-truth + debt provider; this adds your written notes).
//
// It speaks the clean contract verbs:
//   recall --file P [--file Q] --json   notes in the vault relevant to those paths  -> Finding[] (kind note)
//   record --ref SHA --summary S --by WHO [--side X] [--evidence-file F]            write a note into the vault
//   debt   --json                        EXITS NONZERO: a note vault cannot know what is silenced in HEAD
//                                         (git-truth). The contract has Sawbuck skip an unsupported capability.
//
// It is NOT a git tool: it has no idea what is live in HEAD, so it does not answer `debt`. That is the
// point of the socket: a provider implements the subset it can, and Sawbuck composes the rest.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, relative, extname } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flagAll = (n) => argv.reduce((a, v, i) => (argv[i - 1] === n ? [...a, v] : a), []);
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? (argv[i + 1] ?? true) : d; };

const VAULT = process.env.OBSIDIAN_VAULT || '';
const die = (msg, code = 2) => { process.stderr.write(`obsidian provider: ${msg}\n`); process.exit(code); };

// bounded vault walk: .md files only, skip the heavy/hidden dirs, cap count + per-file size, so a
// recall stays cheap enough to reason about (the per-turn latency question lives here).
const MAX_FILES = +(process.env.OBSIDIAN_MAX_FILES) || 4000;
const MAX_BYTES = 512 * 1024;
function vaultNotes() {
  const out = [];
  const walk = (dir) => {
    if (out.length >= MAX_FILES) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (extname(e.name).toLowerCase() === '.md') out.push(p);
    }
  };
  walk(VAULT);
  return out;
}

if (cmd === 'debt') {
  // a note vault is not git-aware; the contract says signal unsupported by exiting nonzero (Sawbuck
  // skips it and lets a git-truth provider answer debt).
  die('debt is unsupported by a note vault (git-truth lives in a git provider like logbook)', 2);
}

if (cmd === 'recall') {
  if (!VAULT || !existsSync(VAULT)) { console.log('[]'); process.exit(0); } // no vault -> no notes, not an error
  const paths = flagAll('--file');
  if (!paths.length) { console.log('[]'); process.exit(0); }
  // a note is relevant to a path if it mentions the path or its basename. A lead, not a verdict.
  const needles = [...new Set(paths.flatMap((p) => [p, basename(p)]).filter(Boolean))];
  const findings = [];
  for (const file of vaultNotes()) {
    let text = '';
    try { if (statSync(file).size > MAX_BYTES) continue; text = readFileSync(file, 'utf8'); } catch { continue; }
    const hitPath = paths.find((p) => text.includes(p) || text.includes(basename(p)));
    if (!hitPath) continue;
    let hits = 0; for (const n of needles) hits += text.split(n).length - 1;
    const title = (text.match(/^#\s+(.+)$/m) || [, basename(file, '.md')])[1].trim();
    const lineWith = (text.split('\n').find((l) => needles.some((n) => l.includes(n))) || '').trim().slice(0, 160);
    let date = null; try { date = new Date(statSync(file).mtimeMs).toISOString().slice(0, 10); } catch {}
    findings.push({ kind: 'note', path: hitPath, ref: relative(VAULT, file), date, summary: `${title}: ${lineWith}`.slice(0, 280), _hits: hits });
  }
  findings.sort((a, b) => b._hits - a._hits || String(b.date).localeCompare(String(a.date)));
  console.log(JSON.stringify(findings.slice(0, 8).map(({ _hits, ...f }) => f)));
  process.exit(0);
}

if (cmd === 'record') {
  if (!VAULT || !existsSync(VAULT)) die('cannot record: OBSIDIAN_VAULT is unset or missing', 2);
  const ref = flag('--ref', ''), summary = String(flag('--summary', '')), by = String(flag('--by', 'sawbuck'));
  const side = flag('--side', ''), evidence = flag('--evidence-file', '');
  const dir = join(VAULT, 'Sawbuck');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const safeRef = String(ref || Date.now()).replace(/[^\w.-]/g, '_').slice(0, 40);
  const date = new Date().toISOString();
  const body = `---\nsawbuck: finding\nref: ${ref}\nby: ${by}\ndate: ${date}\n---\n\n# ${summary.slice(0, 80)}\n\n${summary}\n\n- ref: \`${ref}\`${side ? `\n- side: ${side}` : ''}${evidence ? `\n- evidence: \`${evidence}\`` : ''}\n`;
  try { writeFileSync(join(dir, `${safeRef}.md`), body); console.log('recorded'); process.exit(0); }
  catch (e) { die(`write failed: ${String(e.message).split('\n')[0]}`, 1); }
}

die(`unknown command '${cmd || ''}' (recall | debt | record)`, 2);
