// memory.mjs, Sawbuck's memory adapter: the single seam between the glue and the memory provider.
// It speaks the Memory Contract (recall/debt/record) over the provider's CLI, so no other glue file
// imports the provider's internals (no SUPPRESS_PAT, no auditHead, no gating functions). logbook is
// the default provider; SAWBUCK_MEMORY_BIN / LB_BIN override. Zero-dep.
//
// Degradation is explicit: a read returns null when the provider FAILS (missing/old/crashed) and []
// when the provider ran and found nothing. Callers decide what a failure means (rank treats it as
// "assume all live, do not penalize"; debt refuses to report a failure as a clean tree).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// resolve the provider bin: env override, installed package (published install), then the dev sibling.
function providerBin() {
  if (process.env.SAWBUCK_MEMORY_BIN) return process.env.SAWBUCK_MEMORY_BIN;
  if (process.env.LB_BIN) return process.env.LB_BIN;
  for (const spec of ['@promptwheel/logbook/bin/logbook.mjs', '@promptwheel/logbook']) { try { return require.resolve(spec); } catch {} }
  return join(HERE, '..', 'logbook', 'bin', 'logbook.mjs');
}
const LB = providerBin();

// run the provider; null on a real failure (nonzero exit / missing bin), the stdout string otherwise.
function run(repo, args, maxBuffer = 512 * 1024 * 1024) {
  try { return execFileSync(process.execPath, [LB, ...args], { cwd: repo, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
// a provider's JSON-array stdout. [] when it is not an array (old provider emitting NDJSON events, say).
function parseArray(out) {
  const t = (out || '').trim();
  if (!t.startsWith('[')) return [];
  try { const v = JSON.parse(t); return Array.isArray(v) ? v : []; } catch { return []; }
}

// --- debt sub-classification (Sawbuck policy, applied once here so the ledger and the per-turn
// surface always agree). The provider supplies the fact + line content; the documented/bare and
// disabled-test reading is ours. Exported so a provider-conformance test can reuse them.
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

// recall() facts: the raw event record (NDJSON, one event per line), for the consumer to rank.
// [] on failure here, since every consumer already treats a missing record as "no history".
export function events(repo) {
  const out = run(repo, ['query', '--json'], 256 * 1024 * 1024);
  if (out === null) return [];
  return out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// debt(): the live suppressions still in the tree, each classified documented/testSkip.
//   opts.paths  scopes it to those paths (the cheap per-turn surface)
//   opts.ref    returns the raw (ungated) set at a past ref (the delta base for `--since`)
// Returns null when the provider FAILED (caller decides), [] when it ran and the tree is clean.
export function debt(repo, { paths = null, ref = null } = {}) {
  const args = ['audit', '--json'];
  if (ref) args.push('--ref', ref);
  if (paths && paths.length) for (const p of paths) args.push('--file', p);
  const out = run(repo, args);
  if (out === null) return null;
  return parseArray(out).map((r) => ({
    file: r.file,
    line: r.line,
    kind: String(r.kind ?? '').trim(),
    content: r.content ?? '',
    since: r.since ?? null,
    sha: r.sha ?? null,
    documented: r.content ? isDocumented(r.content) : false,
    testSkip: isTestSkip(r.kind ?? r.content ?? ''),
  }));
}

// record(): persist a machine-authored, explicitly-unreviewed finding (the write-back). Best-effort;
// never throws into the caller. Mirrors reflect's prior two-try annotate (with grounding, then bare).
export function record(repo, { sha, reason, side, evidenceFile, by = 'sawbuck' }) {
  const text = String(reason).slice(0, 280);
  const full = ['annotate', sha, text];
  if (side) full.push('--side', side);
  if (evidenceFile) full.push('--evidence-file', evidenceFile);
  full.push('--by', by);
  const exec = (a) => execFileSync(process.execPath, [LB, ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { exec(full); return true; }
  catch { try { exec(['annotate', sha, text, '--by', by]); return true; } catch { return false; } }
}
