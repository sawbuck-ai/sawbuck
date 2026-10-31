#!/usr/bin/env node
// debt.mjs, Sawbuck's live-suppression-debt ledger: what is STILL silenced in HEAD right now,
// split by severity (disabled/weakened tests vs lint/type/error suppressions) and ranked worst-
// first. The whole-repo view; `sawbuck context` is the task-scoped one. The live state (git grep of
// HEAD, gated) is the complete lens for CURRENT debt - the historical diff scan under-counts it,
// since debt that predates the clone horizon or arrived via a merge was never observed being added.
// Zero-dep. Usage: node debt.mjs [--repo P] [--top N] [--json]

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const engineBin = (envVar, pkgSubpath, devPath) => {
  if (process.env[envVar]) return process.env[envVar];
  const bare = pkgSubpath.replace(/\/bin\/[^/]*$/, '');
  for (const spec of [pkgSubpath, bare]) { try { return require.resolve(spec); } catch {} }
  return devPath;
};
const LB = engineBin('LB_BIN', '@promptwheel/logbook/bin/logbook.mjs', join(HERE, '..', 'logbook', 'bin', 'logbook.mjs'));

const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? (process.argv[i + 1] ?? true) : d; };
const repo = resolve(flag('--repo', process.cwd()));
const top = Math.max(1, parseInt(flag('--top', '12'), 10) || 12);
const asJson = process.argv.includes('--json');

// A disabled/skipped/weakened TEST is a hidden-failure risk; a lint/type/error suppression is
// usually mundane. Same split sawbuck's rank uses, so the two faces agree.
const isTestSkip = (m) => /\bit\.skip\b|\btest\.skip\b|xit\(|xdescribe\(|\bdescribe\.skip\b|pytest\.mark\.skip|unittest\.skip|\bt\.Skip\b|@Disabled\b|@Ignore\b|^\[Ignore\b|^Skip\s*=|^#\[ignore|markTestSkipped|markTestIncomplete/.test(String(m).trim());

// events give the ledger its dates (since-when). Best-effort: a dateless ledger still ranks.
let events = [];
try { events = execFileSync(process.execPath, [LB, 'query', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}

let live;
try { const { auditHead } = await import(pathToFileURL(LB).href); live = auditHead(repo, events); }
catch (e) { console.error(`sawbuck debt: could not read the suppression ledger (${String(e.message).split('\n')[0]})`); process.exit(1); }

if (!live.length) {
  console.log(asJson ? '{"total":0,"testSkips":0,"codeSuppressions":0,"files":[]}' : '🐴 sawbuck: no live suppression debt in HEAD (nothing silenced in src/test/config). A clean tree.');
  process.exit(0);
}

// Fragility: debt on code that keeps breaking (reverts, fix-bursts) is the debt that matters - you
// silenced a warning on already-shaky ground. Debt on stable code is mostly noise (the study's
// volume+mundanity lesson). One pass over the events we already loaded builds per-file history, and
// a file's debt severity is multiplied by how fragile it is, so count-heavy-but-stable sinks and
// debt-on-a-hotspot rises. Same revert/fix-burst signals rank.mjs uses, so the faces agree.
const DAY = 86400000;
const resolveRename = (f) => f.replace(/\{[^}]*=>\s*([^}]*)\}/g, '$1').replace(/\/{2,}/g, '/');
const hist = new Map();
for (const e of events) {
  const rv = !!e.revert, fx = !!e.fix;
  if (!rv && !fx) continue;
  for (const raw of (e.files || [])) {
    const f = resolveRename(raw);
    const h = hist.get(f) || { reverts: 0, fixes: 0, fixDates: [] };
    if (rv) h.reverts++;
    if (fx) { h.fixes++; if (e.date) h.fixDates.push(Date.parse(e.date)); }
    hist.set(f, h);
  }
}
const fragilityOf = (file) => {
  const h = hist.get(file) || { reverts: 0, fixes: 0, fixDates: [] };
  const fd = [...h.fixDates].sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0; i + 2 < fd.length; i++) if (fd[i + 2] - fd[i] <= 30 * DAY) { burst = fd.filter((x) => x >= fd[i] && x <= fd[i] + 30 * DAY).length; break; }
  const hot = burst >= 3;
  // bounded multiplier: a revert is the strongest fragility signal, a fix-burst next, raw fixes mild.
  const mult = 1 + Math.min(3, h.reverts * 0.75 + (hot ? 1 : 0) + h.fixes * 0.1);
  return { reverts: h.reverts, fixes: h.fixes, hot, mult };
};

const byFile = new Map();
let testSkips = 0, codeSup = 0;
for (const it of live) {
  const t = isTestSkip(it.kind); t ? testSkips++ : codeSup++;
  const f = byFile.get(it.file) || { file: it.file, skips: 0, sup: 0, kinds: new Set(), oldest: null };
  t ? f.skips++ : f.sup++;
  f.kinds.add(String(it.kind).trim());
  if (it.date && (!f.oldest || it.date < f.oldest)) f.oldest = it.date;
  byFile.set(it.file, f);
}
// rank by RISK = severity (disabled test 3:1 over a lint suppression) x file fragility (reverts/
// hotspots). Debt on stable code keeps its base severity; debt on code that keeps breaking rises.
const files = [...byFile.values()].map((f) => {
  const sev = f.skips * 3 + f.sup;
  const fr = fragilityOf(f.file);
  return { file: f.file, n: f.skips + f.sup, skips: f.skips, sup: f.sup, oldest: f.oldest, sev, reverts: fr.reverts, fixes: fr.fixes, hot: fr.hot, risk: +(sev * fr.mult).toFixed(1) };
}).sort((a, b) => b.risk - a.risk || b.n - a.n);
const onFragile = files.filter((f) => f.reverts > 0 || f.hot).length;

if (asJson) {
  console.log(JSON.stringify({ total: live.length, testSkips, codeSuppressions: codeSup, filesOnFragileCode: onFragile, files: files.map((f) => ({ file: f.file, live: f.n, testSkips: f.skips, suppressions: f.sup, reverts: f.reverts, hot: f.hot, risk: f.risk, oldest: f.oldest })) }, null, 2));
  process.exit(0);
}

const out = [];
out.push(`🐴 sawbuck: live suppression debt in ${basename(repo)}`);
out.push(`   ${live.length} still silenced in HEAD  ·  ${testSkips} disabled/weakened test${testSkips === 1 ? '' : 's'} (hidden-failure risk)  ·  ${codeSup} lint/type suppression${codeSup === 1 ? '' : 's'}`);
if (onFragile) out.push(`   ${onFragile} of ${files.length} debt-carrying files sit on fragile code (reverts/hotspots); look there first`);
out.push(`\n   highest-risk debt (severity x how fragile the file is):`);
for (const f of files.slice(0, top)) {
  const bits = [f.skips ? `${f.skips} test` : '', f.sup ? `${f.sup} lint/type` : ''].filter(Boolean).join(' + ');
  const frag = [f.reverts ? `${f.reverts} revert${f.reverts === 1 ? '' : 's'}` : '', f.hot ? 'fix-hotspot' : '', (!f.hot && f.fixes >= 3) ? `${f.fixes} fixes` : ''].filter(Boolean).join(', ');
  out.push(`     ${f.reverts || f.hot ? '🔥 ' : '   '}${f.file}  ·  ${f.n} (${bits})${frag ? `  · ${frag}` : ''}  ·  risk ${f.risk}`);
}
const dated = live.filter((it) => it.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
if (dated.length) {
  out.push(`\n   oldest still-silenced (most stale):`);
  for (const it of dated.slice(0, 5)) out.push(`     ${it.file}:${it.line}  ${String(it.kind).trim()}  (since ${it.date})`);
}
out.push(`\n   leads, not verdicts; a suppression may be intentional. full dated ledger: logbook audit`);
console.log(out.join('\n'));
