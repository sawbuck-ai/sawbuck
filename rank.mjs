#!/usr/bin/env node
// rank.mjs, query-conditioned relevance for Sawbuck's read face.
// Given the paths a change touches, score each path's history by
// severity x recency x recurrence, so the agent sees the few relevant warnings
// for what it is about to edit, not the whole book.
// Zero-dep. Usage:
//   node rank.mjs [--repo P] [--base REF --head REF] [--file P ...] [--top N] [--json]
//   default paths = files changed in base..head (base=HEAD~1, head=HEAD)
//
// Note: logbook `query --file` does not narrow the --json record, so we pull the
// record once and filter client-side by e.files (resolving `{old => new}`
// renames). v1 does not follow a file across a pre-rename name.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const engineBin = (envVar, pkgSubpath, devPath) => {
  if (process.env[envVar]) return process.env[envVar];
  // deep bin subpath (no-exports pkgs, e.g. promptwheel), then the bare package name
  // (pkgs whose exports map "." to the bin, e.g. @promptwheel/logbook), then the dev sibling.
  const bare = pkgSubpath.replace(/\/bin\/[^/]*$/, '');
  for (const spec of [pkgSubpath, bare]) { try { return require.resolve(spec); } catch {} }
  return devPath;
};
const LB = engineBin('LB_BIN', '@promptwheel/logbook/bin/logbook.mjs', join(HERE, '..', 'logbook', 'bin', 'logbook.mjs'));

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const multi = (n) => process.argv.reduce((a, v, i) => (process.argv[i - 1] === n ? [...a, v] : a), []);
const repo = arg('--repo', process.cwd());
const base = arg('--base', 'HEAD~1');
const head = arg('--head', 'HEAD');
const top = parseInt(arg('--top', '5'), 10);
const asJson = process.argv.includes('--json');

const git = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } };

let paths = multi('--file');
if (!paths.length) paths = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
if (!paths.length) { console.log(asJson ? '[]' : 'rank: no paths to rank'); process.exit(0); }

// pull the full event record once (query --file does not narrow --json)
let record = '';
try { record = execFileSync(process.execPath, [LB, 'query', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }
catch (e) { record = (e.stdout || '').toString(); }
const EVENTS = record.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const resolveRename = (f) => f.replace(/\{[^}]*=>\s*([^}]*)\}/g, '$1').replace(/\/{2,}/g, '/');
const touches = (e, p) => (e.files || []).some((f) => resolveRename(f) === p);

const now = Date.now();
const recency = (d) => 1 / (1 + Math.max(0, (now - Date.parse(d)) / 86400000) / 120); // ~4-month half-weight
// weaken/suppress are commit-level signals; only credit them to code/test files,
// not the README/config that merely rode along in the same commit.
const codeish = (p) => /\.(m?[jt]sx?|cjs|py|go|rs|rb|java|kt|c|cc|cpp|h|hpp|php|swift|scala|clj|ex|exs)$/i.test(p);

const DAY = 86400000;
const ranked = paths.map((p) => {
  let score = 0; const hits = []; const fixDates = [];
  for (const e of EVENTS) {
    if (!touches(e, p)) continue;
    if (e.fix) fixDates.push(Date.parse(e.date));
    let w = 0, kind = null;
    if (e.revert) { w = 3; kind = 'revert (do-not-retry)'; }
    // "weakened" only on a NET assertion drop (logbook's own rule: del > add + 2), 
    // a rewrite that removes some asserts but adds more is not a weakening.
    else if (codeish(p) && ((e.suppressions && e.suppressions.length) || ((e.del_asserts || 0) > (e.add_asserts || 0) + 2) || e.downgrades > 0)) { w = 2; kind = 'test weakened / suppressed'; }
    else if (e.fix) { w = 1.2; kind = 'bugfix here'; }
    else continue;
    const weighted = w * recency(e.date);
    score += weighted;
    hits.push({ sha: e.sha, date: e.date, kind, subject: e.subject, w: +weighted.toFixed(2) });
  }
  // burst: >=3 bug-fixes clustered inside any 30-day window = actively on fire.
  // At 153-repo scale it is ~11% precision / 7.5x lift, modestly better than the flat
  // lifetime signal (~8% / 5.2x). A useful lead, not a verdict; boosted but honest.
  fixDates.sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0; i + 2 < fixDates.length; i++) if (fixDates[i + 2] - fixDates[i] <= 30 * DAY) { burst = fixDates.filter((x) => x >= fixDates[i] && x <= fixDates[i] + 30 * DAY).length; break; }
  if (burst >= 3) { score += 4; hits.unshift({ date: new Date(fixDates[fixDates.length - 1]).toISOString().slice(0, 10), kind: `HOT: ${burst} fixes in 30 days`, subject: 'this file was actively on fire, verify carefully', w: 99 }); }
  hits.sort((a, b) => b.w - a.w);
  return { path: p, score: +score.toFixed(2), top: hits.slice(0, 3), hot: burst >= 3 };
}).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, top);

if (asJson) { console.log(JSON.stringify(ranked, null, 2)); process.exit(0); }
if (!ranked.length) { console.log('rank: nothing notable in the history of the touched paths'); process.exit(0); }

const out = [`relevant history for ${paths.length} touched path${paths.length === 1 ? '' : 's'} (top ${ranked.length}):`];
for (const r of ranked) {
  out.push(`\n  ${r.hot ? '🔥 ' : ''}${r.path}  ·  score ${r.score}`);
  for (const h of r.top) out.push(`    - ${h.kind}: ${h.subject}${h.sha ? ` (${h.sha}, ${h.date})` : ''}`);
}
out.push('\n  leads, not conclusions; verify against the diff before acting.');
console.log(out.join('\n'));
