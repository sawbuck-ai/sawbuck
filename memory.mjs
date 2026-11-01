// memory.mjs, Sawbuck's memory adapter: the single seam between the glue and the memory provider(s).
// It speaks the Memory Contract (recall / debt / record) over a provider's CLI, so no other glue file
// imports a provider's internals. Zero-dep.
//
// Providers: SAWBUCK_MEMORY is an ordered, comma-separated list (default "logbook"). An entry is
// either the built-in "logbook" (the reference provider, adapted to its native query/audit/annotate
// verbs) or another provider that speaks the clean contract verbs: `recall --file P --json`,
// `debt [--since REF] --json`, `record --ref SHA --summary S [--side X] [--evidence-file F] --by WHO`.
// The shipped reference non-git provider is "obsidian" (providers/obsidian.mjs); point at any other
// with SAWBUCK_MEMORY_<NAME>_BIN or a path entry.
//
// Degradation is explicit: a read returns null when its PRIMARY (git-truth) source failed, [] when it
// ran clean. A provider that does not support a capability signals it by exiting nonzero (we skip it),
// never by printing []. git-truth stays authoritative; other providers add supplementary notes.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname, relative, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function logbookBin() {
  if (process.env.SAWBUCK_MEMORY_BIN) return process.env.SAWBUCK_MEMORY_BIN; // back-compat single-provider override
  if (process.env.LB_BIN) return process.env.LB_BIN;
  for (const spec of ['@promptwheel/logbook/bin/logbook.mjs', '@promptwheel/logbook']) { try { return require.resolve(spec); } catch {} }
  return join(HERE, '..', 'logbook', 'bin', 'logbook.mjs');
}
const envKey = (name) => 'SAWBUCK_MEMORY_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_BIN';
// the ordered provider list. Each: { name, bin, dialect: 'logbook' | 'contract' }.
const SHIPPED = new Set(['obsidian', 'mem0']); // reference contract providers that ship in providers/
export function providers() {
  const spec = (process.env.SAWBUCK_MEMORY || 'logbook').split(',').map((s) => s.trim()).filter(Boolean);
  return spec.map((name) => {
    if (name === 'logbook') return { name, bin: logbookBin(), dialect: 'logbook' };
    if (SHIPPED.has(name)) return { name, bin: process.env[envKey(name)] || join(HERE, 'providers', name + '.mjs'), dialect: 'contract' };
    return { name, bin: process.env[envKey(name)] || name, dialect: 'contract' }; // a bin path, or a name with an env-set bin
  });
}

// scopeChain(): the folder-based scope chain for a repo, most-specific first: the repo, then each
// ancestor up to the memory root, then the root ("" = the shared/global scope). ISOLATION BY DEFAULT:
// with no configured root the chain is just the leaf, so a repo sees only itself and never a sibling.
// A root is SAWBUCK_MEMORY_ROOT, or the nearest ancestor holding a `.sawbuck-root` marker; with one,
// a repo also inherits its ancestors' shared memory. Ids are paths relative to the root (forward
// slashes), so sibling repos with the same basename never collide and never leak into each other.
export function scopeChain(repo) {
  const start = resolve(repo);
  let root = process.env.SAWBUCK_MEMORY_ROOT ? resolve(process.env.SAWBUCK_MEMORY_ROOT) : null;
  if (!root) {
    let d = start; const stop = resolve(homedir());
    for (let i = 0; i < 64; i++) {
      if (existsSync(join(d, '.sawbuck-root'))) { root = d; break; }
      const up = dirname(d);
      if (up === d || d === stop) break;
      d = up;
    }
  }
  if (root && (start === root || start.startsWith(root + sep))) {
    const idOf = (dir) => relative(root, dir).split(sep).join('/'); // "" for the root itself
    const chain = [];
    let d = start;
    for (let i = 0; i < 64; i++) {
      chain.push(idOf(d));
      if (d === root) break;
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
    return chain; // leaf-first, ending with "" (root = shared/global)
  }
  return [basename(start) || '.']; // no root in play: an isolated leaf, no inheritance
}

// run a provider bin; null on a real failure / unsupported-capability (nonzero exit), stdout otherwise.
function run(bin, repo, args, maxBuffer = 512 * 1024 * 1024) {
  try { return execFileSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
function parseArray(out) {
  const t = (out || '').trim();
  if (!t.startsWith('[')) return [];
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; }
}

// --- debt sub-classification (Sawbuck policy; applied once so the ledger and the per-turn surface
// agree). Exported so the conformance checker can reuse them.
export const isTestSkip = (m) => /\bit\.skip\b|\btest\.skip\b|xit\(|xdescribe\(|\bdescribe\.skip\b|pytest\.mark\.skip|unittest\.skip|\bt\.Skip\b|@Disabled\b|@Ignore\b|^\[Ignore\b|^Skip\s*=|^#\[ignore|markTestSkipped|markTestIncomplete/.test(String(m).trim());
export const isDocumented = (c) => {
  c = String(c || '');
  if (/eslint-disable/.test(c)) return /eslint-disable(?:-next-line|-line)?\s+\S/.test(c);
  if (/@ts-ignore/.test(c)) return false;
  if (/@ts-expect-error/.test(c)) return /@ts-expect-error\s+\S/.test(c);
  if (/noqa/i.test(c)) return /noqa:\s*\w/i.test(c);
  if (/type:\s*ignore/i.test(c)) return /ignore\s*\[/.test(c);
  return /\(\s*["']/.test(c) || /=\s*["']/.test(c);
};

const classify = (r, source) => ({
  file: r.file, line: r.line, kind: String(r.kind ?? '').trim(), content: r.content ?? '',
  since: r.since ?? null, sha: r.sha ?? null,
  documented: r.content ? isDocumented(r.content) : false,
  testSkip: isTestSkip(r.kind ?? r.content ?? ''),
  source,
});

// events(): the raw git event record (the ranking input), from the logbook-dialect provider only
// (events with revert/fix/suppression semantics are git-truth; a note provider does not produce them).
// [] when there is no such provider or it fails, exactly as "no history".
export function events(repo) {
  const lb = providers().find((p) => p.dialect === 'logbook');
  if (!lb) return [];
  const out = run(lb.bin, repo, ['query', '--json'], 256 * 1024 * 1024);
  if (out === null) return [];
  return out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// the per-provider debt call, dialect-aware.
function debtRaw(p, repo, { paths, ref }) {
  const args = p.dialect === 'logbook'
    ? ['audit', '--json', ...(ref ? ['--ref', ref] : []), ...((paths || []).flatMap((f) => ['--file', f]))]
    : ['debt', '--json', ...(ref ? ['--since', ref] : []), ...((paths || []).flatMap((f) => ['--file', f]))];
  return run(p.bin, repo, args);
}

// debt(): live suppressions still in the tree, each classified. Fans out across providers that SUPPORT
// debt (git-truth); a provider that does not implement it exits nonzero and is skipped. Returns null
// only when NO provider answered (unmeasurable, not clean); [] when a provider ran and the tree is
// clean. Default (logbook-only) is byte-identical to the single-provider behavior.
export function debt(repo, { paths = null, ref = null } = {}) {
  let answered = false;
  const rows = [];
  for (const p of providers()) {
    const out = debtRaw(p, repo, { paths, ref });
    if (out === null) continue;              // failed or unsupported -> skip
    answered = true;
    for (const r of parseArray(out)) rows.push(classify(r, p.name));
  }
  return answered ? rows : null;
}

// recall(): supplementary relevant NOTES for the touched paths, from providers that produce them
// (contract-dialect; logbook's own history is surfaced via rank, not here). Each is a Finding of kind
// note/decision, source-tagged. [] when nothing relevant. git-truth is never diluted by these.
export function recall(repo, paths) {
  const scopeArgs = scopeChain(repo).flatMap((id) => ['--scope', id]); // leaf-first: self + ancestors, never siblings
  const out = [];
  for (const p of providers()) {
    if (p.dialect !== 'contract') continue;
    const r = run(p.bin, repo, ['recall', '--json', ...((paths || []).flatMap((f) => ['--file', f])), ...scopeArgs]);
    if (r === null) continue;
    for (const it of parseArray(r)) out.push({ kind: String(it.kind || 'note'), path: it.path ?? null, ref: it.ref ?? null, date: it.date ?? null, summary: String(it.summary || '').slice(0, 280), source: p.name, scope: it.scope ?? null });
  }
  return out;
}

// conform(): read-only conformance probe of a contract-dialect provider bin. Checks recall returns a
// JSON array (or errors cleanly) and that debt either returns an array (git-truth) or signals
// unsupported by exiting nonzero (never a bare []). Does not write, so record is validated elsewhere
// (the record fan-out). Returns a report the `memory-conformance` command prints.
export function conform(bin, repo, probePath = 'README.md') {
  const probe = (args) => { try { return { out: execFileSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }), code: 0 }; } catch (e) { return { out: (e.stdout || '').toString(), code: e.status || 1 }; } };
  const isArray = (s) => { s = (s || '').trim(); if (!s.startsWith('[')) return false; try { return Array.isArray(JSON.parse(s)); } catch { return false; } };
  const r = probe(['recall', '--json', '--file', probePath]);
  const recall = r.code !== 0 ? 'error (nonzero exit on recall)' : (isArray(r.out) ? 'ok (Finding[])' : 'bad shape (recall must print a JSON array)');
  const d = probe(['debt', '--json']);
  const debt = d.code !== 0 ? 'unsupported (exits nonzero, ok for a non-git provider)' : (isArray(d.out) ? 'supported (Suppression[])' : 'bad shape (debt must print a JSON array or exit nonzero)');
  const pass = /^ok/.test(recall) && !/bad shape/.test(debt);
  return { bin, recall, debt, pass };
}

// record(): persist a machine finding to every WRITABLE provider (the write-back). Best-effort; never
// throws into the caller. Returns true if at least one provider accepted it.
export function record(repo, { sha, reason, side, evidenceFile, by = 'sawbuck' }) {
  const text = String(reason).slice(0, 280);
  const leaf = scopeChain(repo)[0]; // a finding belongs to the most-specific scope that produced it
  let ok = false;
  for (const p of providers()) {
    const exec = (a) => execFileSync(process.execPath, [p.bin, ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      if (p.dialect === 'logbook') {
        const full = ['annotate', sha, text, ...(side ? ['--side', side] : []), ...(evidenceFile ? ['--evidence-file', evidenceFile] : []), '--by', by];
        try { exec(full); } catch { exec(['annotate', sha, text, '--by', by]); }
      } else {
        exec(['record', '--ref', sha, '--summary', text, ...(side ? ['--side', side] : []), ...(evidenceFile ? ['--evidence-file', evidenceFile] : []), '--scope', leaf, '--by', by]);
      }
      ok = true;
    } catch { /* this provider declined; others may still accept */ }
  }
  return ok;
}
