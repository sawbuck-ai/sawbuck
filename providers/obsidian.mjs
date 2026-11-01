#!/usr/bin/env node
// obsidian.mjs, a REFERENCE memory provider for Sawbuck's Memory Contract: an Obsidian vault as the
// memory. Shows how to fill the socket, and the second contract implementation. Zero-dep. Opt in with
// SAWBUCK_MEMORY=logbook,obsidian and OBSIDIAN_VAULT=/path/to/vault (compose it WITH logbook: logbook
// stays the git-truth + debt provider, this adds your written notes).
//
//   recall --file P [--file Q] [--scope ID ...] --json   notes relevant to those paths -> Finding[] (kind note)
//   record --ref SHA --summary S --by WHO [--scope ID]   write a note into the vault
//   debt   --json                        EXITS NONZERO: a note vault cannot know what is silenced in HEAD
//
// FOLDER SCOPING (isolation): --scope carries the folder scope chain, leaf-first, as paths relative to
// the memory root (Sawbuck computes them; "" is the vault root = shared/global). The vault MIRRORS the
// project tree: notes for scope "group/repo" live in `<vault>/group/repo/`. recall searches the LEAF
// scope recursively (so the repo's own notes + its Sawbuck/ folder are found) and each ANCESTOR scope
// TOP-LEVEL ONLY (so it never descends into a sibling repo's folder). With no --scope it searches the
// whole vault (direct calls / back-compat). record writes to the LEAF scope's Sawbuck/ folder.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, relative, extname, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flagAll = (n) => argv.reduce((a, v, i) => (argv[i - 1] === n ? [...a, v] : a), []);
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? (argv[i + 1] ?? true) : d; };

const VAULT = process.env.OBSIDIAN_VAULT ? resolve(process.env.OBSIDIAN_VAULT) : '';
const die = (msg, code = 2) => { process.stderr.write(`obsidian provider: ${msg}\n`); process.exit(code); };

const MAX_FILES = +(process.env.OBSIDIAN_MAX_FILES) || 4000;
const MAX_BYTES = 512 * 1024;

// resolve a scope id to a dir INSIDE the vault; null if it would escape (path-traversal guard).
function scopeDir(id) {
  if (id === '' || id == null) return VAULT;
  const p = resolve(VAULT, id);
  return (p === VAULT || p.startsWith(VAULT + sep)) ? p : null;
}
// collect .md files; recursive for the leaf scope, top-level only for an ancestor (so an ancestor
// search never descends into a sibling repo's folder).
function walkMd(dir, recursive, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (recursive) walkMd(p, true, out); }
    else if (extname(e.name).toLowerCase() === '.md') out.push(p);
  }
}
// the dirs to search, with their scope id and recursion, from the --scope chain (leaf-first).
function searchScopes(scopes) {
  if (!scopes.length) return [{ id: '', dir: VAULT, recursive: true }]; // no scope -> whole vault
  const out = []; const seen = new Set();
  scopes.forEach((id, i) => {
    const dir = scopeDir(id);
    if (!dir || seen.has(dir)) return; seen.add(dir);
    out.push({ id, dir, recursive: i === 0 }); // leaf recursive; ancestors top-level only
  });
  if (!seen.has(VAULT)) out.push({ id: '', dir: VAULT, recursive: false }); // vault root is the shared scope
  return out;
}

if (cmd === 'debt') {
  die('debt is unsupported by a note vault (git-truth lives in a git provider like logbook)', 2);
}

if (cmd === 'recall') {
  if (!VAULT || !existsSync(VAULT)) { console.log('[]'); process.exit(0); }
  const paths = flagAll('--file');
  if (!paths.length) { console.log('[]'); process.exit(0); }
  const needles = [...new Set(paths.flatMap((p) => [p, basename(p)]).filter(Boolean))];
  const findings = [];
  for (const { id, dir, recursive } of searchScopes(flagAll('--scope'))) {
    const files = []; walkMd(dir, recursive, files);
    for (const file of files) {
      let text = '';
      try { if (statSync(file).size > MAX_BYTES) continue; text = readFileSync(file, 'utf8'); } catch { continue; }
      const hitPath = paths.find((p) => text.includes(p) || text.includes(basename(p)));
      if (!hitPath) continue;
      let hits = 0; for (const n of needles) hits += text.split(n).length - 1;
      const title = (text.match(/^#\s+(.+)$/m) || [, basename(file, '.md')])[1].trim();
      const lineWith = (text.split('\n').find((l) => needles.some((n) => l.includes(n))) || '').trim().slice(0, 160);
      let date = null; try { date = new Date(statSync(file).mtimeMs).toISOString().slice(0, 10); } catch {}
      findings.push({ kind: 'note', path: hitPath, ref: relative(VAULT, file), date, summary: `${title}: ${lineWith}`.slice(0, 280), scope: id, _hits: hits });
    }
  }
  findings.sort((a, b) => b._hits - a._hits || String(b.date).localeCompare(String(a.date)));
  console.log(JSON.stringify(findings.slice(0, 8).map(({ _hits, ...f }) => f)));
  process.exit(0);
}

if (cmd === 'record') {
  if (!VAULT || !existsSync(VAULT)) die('cannot record: OBSIDIAN_VAULT is unset or missing', 2);
  const ref = flag('--ref', ''), summary = String(flag('--summary', '')), by = String(flag('--by', 'sawbuck'));
  const side = flag('--side', ''), evidence = flag('--evidence-file', '');
  const leaf = flagAll('--scope')[0] ?? '';
  const base = scopeDir(leaf) || VAULT;                 // the finding belongs to its most-specific scope
  const dir = join(base, 'Sawbuck');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const safeRef = String(ref || Date.now()).replace(/[^\w.-]/g, '_').slice(0, 40);
  const date = new Date().toISOString();
  // a [[wikilink]] to the evidence path so Obsidian's graph connects the finding to the code note.
  const link = evidence ? `\n- evidence: [[${String(evidence).replace(/[[\]]/g, '')}]]` : '';
  const body = `---\nsawbuck: finding\nref: ${ref}\nby: ${by}\ndate: ${date}\nscope: ${leaf}\n---\n\n# ${summary.slice(0, 80)}\n\n${summary}\n\n- ref: \`${ref}\`${side ? `\n- side: ${side}` : ''}${link}\n`;
  try { writeFileSync(join(dir, `${safeRef}.md`), body); console.log('recorded'); process.exit(0); }
  catch (e) { die(`write failed: ${String(e.message).split('\n')[0]}`, 1); }
}

die(`unknown command '${cmd || ''}' (recall | debt | record)`, 2);
