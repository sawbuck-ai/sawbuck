#!/usr/bin/env node
// debt.mjs, Sawbuck's live-suppression-debt ledger: what is STILL silenced in HEAD right now,
// split by severity (disabled/weakened tests vs lint/type/error suppressions), risk-ranked by how
// fragile each file is (reverts/fix-bursts), and split by whether each suppression is DOCUMENTED (a
// rule code or reason) or BARE (just the directive, nobody wrote why). The whole-repo view;
// `sawbuck context` is the task-scoped one. The live state (git grep of HEAD, gated) is the
// complete lens for CURRENT debt; the historical diff scan under-counts it.
// Zero-dep. Usage: node debt.mjs [--repo P] [--top N] [--since REF] [--json]

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
const since = flag('--since', null);
const asJson = process.argv.includes('--json');

// A disabled/skipped/weakened TEST is a hidden-failure risk; a lint/type/error suppression is
// usually mundane. Same split sawbuck's rank uses, so the two faces agree.
const isTestSkip = (m) => /\bit\.skip\b|\btest\.skip\b|xit\(|xdescribe\(|\bdescribe\.skip\b|pytest\.mark\.skip|unittest\.skip|\bt\.Skip\b|@Disabled\b|@Ignore\b|^\[Ignore\b|^Skip\s*=|^#\[ignore|markTestSkipped|markTestIncomplete/.test(String(m).trim());
// DOCUMENTED = a rule code or reason follows the directive (declared intent); BARE = just the
// directive. Heuristic, a lead not a verdict, but bare is the suspect kind worth scrutinizing.
const isDocumented = (c) => {
  c = String(c || '');
  if (/eslint-disable/.test(c)) return /eslint-disable(?:-next-line|-line)?\s+\S/.test(c); // a rule name follows
  if (/@ts-ignore/.test(c)) return false;                                                  // inherently undocumented
  if (/@ts-expect-error/.test(c)) return /@ts-expect-error\s+\S/.test(c);
  if (/noqa/i.test(c)) return /noqa:\s*\w/i.test(c);                                        // # noqa: E501
  if (/type:\s*ignore/i.test(c)) return /ignore\s*\[/.test(c);                              // # type: ignore[code]
  return /\(\s*["']/.test(c) || /=\s*["']/.test(c);   // annotation reason/code: @Disabled("..."), Skip="...", #[ignore = "..."]
};

// events give fragility + fall-back dates. Best-effort.
let events = [];
try { events = execFileSync(process.execPath, [LB, 'query', '--json'], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}

let auditHead, SUPPRESS_PAT;
try { ({ auditHead, SUPPRESS_PAT } = await import(pathToFileURL(LB).href)); } catch (e) { console.error(`sawbuck debt: cannot load logbook (${String(e.message).split('\n')[0]})`); process.exit(1); }

let live;
try { live = auditHead(repo, events); } catch (e) { console.error(`sawbuck debt: could not read the suppression ledger (${String(e.message).split('\n')[0]})`); process.exit(1); }

// enrich each gated live suppression with its line content, so we can tell BARE from DOCUMENTED.
// One extra HEAD grep; we only read content for lines auditHead already gated, so no gating drift.
const grepAt = (ref) => { try { return execFileSync('git', ['-C', repo, 'grep', '-nP', SUPPRESS_PAT.source, ref], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }); } catch (e) { return (e.stdout || '').toString(); } };
const parseGrep = (g, ref) => { const re = new RegExp('^' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(.+?):(\\d+):(.*)$'); const m = []; for (const row of g.split('\n')) { const x = re.exec(row); if (x) m.push({ file: x[1], line: +x[2], content: x[3] }); } return m; };
const headRows = SUPPRESS_PAT ? parseGrep(grepAt('HEAD'), 'HEAD') : [];
const contentAt = new Map(headRows.map((r) => [r.file + ':' + r.line, r.content]));
for (const it of live) { it.content = contentAt.get(it.file + ':' + it.line) || ''; it.documented = it.content ? isDocumented(it.content) : false; }
const bare = live.filter((it) => !it.documented && it.content).length;

// --since REF: the DELTA. Suppressions in HEAD but not at REF = debt this branch/PR adds.
if (since && typeof since === 'string') {
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
  const base = new Set(parseGrep(grepAt(since), since).map((r) => r.file + '\u0000' + norm(r.content)));
  const added = live.filter((it) => it.content && !base.has(it.file + '\u0000' + norm(it.content)));
  if (asJson) { console.log(JSON.stringify({ since, added: added.length, testSkips: added.filter((it) => isTestSkip(it.kind)).length, undocumented: added.filter((it) => !it.documented).length, items: added.map((it) => ({ file: it.file, line: it.line, kind: String(it.kind).trim(), documented: it.documented })) }, null, 2)); process.exit(0); }
  if (!added.length) { console.log(`🐴 sawbuck: no new suppression debt since ${since} (clean).`); process.exit(0); }
  const skips = added.filter((it) => isTestSkip(it.kind)).length, undoc = added.filter((it) => !it.documented).length;
  const o = [`🐴 sawbuck: ${added.length} new suppression${added.length === 1 ? '' : 's'} since ${since}  ·  ${skips} disabled test${skips === 1 ? '' : 's'}  ·  ${undoc} undocumented (no code/reason)`];
  for (const it of added.slice(0, Math.max(top, 20))) o.push(`     ${isTestSkip(it.kind) ? '🔴' : (it.documented ? '  ' : '✎ ')} ${it.file}:${it.line}  ${String(it.kind).trim()}${it.documented ? '' : '   (bare - no code/reason)'}`);
  o.push(`\n   ✎ = bare/undocumented (the suspect kind); declare intent (a rule code or reason) or remove it.`);
  console.log(o.join('\n'));
  process.exit(0);
}

if (!live.length) { console.log(asJson ? '{"total":0,"testSkips":0,"codeSuppressions":0,"undocumented":0,"files":[]}' : '🐴 sawbuck: no live suppression debt in HEAD (nothing silenced in src/test/config). A clean tree.'); process.exit(0); }

// Fragility: debt on code that keeps breaking (reverts, fix-bursts) is the debt that matters; debt
// on stable code is mostly noise. One pass over the events builds per-file history; a file's debt
// severity is multiplied by its fragility. Same signals rank.mjs uses.
const DAY = 86400000;
const resolveRename = (f) => f.replace(/\{[^}]*=>\s*([^}]*)\}/g, '$1').replace(/\/{2,}/g, '/');
const histMap = new Map();
for (const e of events) {
  const rv = !!e.revert, fx = !!e.fix;
  if (!rv && !fx) continue;
  for (const raw of (e.files || [])) {
    const f = resolveRename(raw);
    const h = histMap.get(f) || { reverts: 0, fixes: 0, fixDates: [] };
    if (rv) h.reverts++;
    if (fx) { h.fixes++; if (e.date) h.fixDates.push(Date.parse(e.date)); }
    histMap.set(f, h);
  }
}
const fragilityOf = (file) => {
  const h = histMap.get(file) || { reverts: 0, fixes: 0, fixDates: [] };
  const fd = [...h.fixDates].sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0; i + 2 < fd.length; i++) if (fd[i + 2] - fd[i] <= 30 * DAY) { burst = fd.filter((x) => x >= fd[i] && x <= fd[i] + 30 * DAY).length; break; }
  const hot = burst >= 3;
  const mult = 1 + Math.min(3, h.reverts * 0.75 + (hot ? 1 : 0) + h.fixes * 0.1);
  return { reverts: h.reverts, fixes: h.fixes, hot, mult };
};

const byFile = new Map();
let testSkips = 0, codeSup = 0;
for (const it of live) {
  const t = isTestSkip(it.kind); t ? testSkips++ : codeSup++;
  const f = byFile.get(it.file) || { file: it.file, skips: 0, bareSup: 0, docSup: 0, kinds: new Set(), oldest: null };
  if (t) f.skips++; else (it.documented ? f.docSup++ : f.bareSup++);
  f.kinds.add(String(it.kind).trim());
  if (it.date && (!f.oldest || it.date < f.oldest)) f.oldest = it.date;
  byFile.set(it.file, f);
}
// RISK = severity (disabled test 3, bare suppression 1.5, documented 1) x file fragility.
const files = [...byFile.values()].map((f) => {
  const sup = f.bareSup + f.docSup;
  const sev = f.skips * 3 + f.bareSup * 1.5 + f.docSup * 1;
  const fr = fragilityOf(f.file);
  return { file: f.file, n: f.skips + sup, skips: f.skips, sup, bareSup: f.bareSup, oldest: f.oldest, reverts: fr.reverts, fixes: fr.fixes, hot: fr.hot, risk: +(sev * fr.mult).toFixed(1) };
}).sort((a, b) => b.risk - a.risk || b.n - a.n);
const onFragile = files.filter((f) => f.reverts > 0 || f.hot).length;

if (asJson) {
  console.log(JSON.stringify({ total: live.length, testSkips, codeSuppressions: codeSup, undocumented: bare, filesOnFragileCode: onFragile, files: files.map((f) => ({ file: f.file, live: f.n, testSkips: f.skips, suppressions: f.sup, undocumented: f.bareSup, reverts: f.reverts, hot: f.hot, risk: f.risk, oldest: f.oldest })) }, null, 2));
  process.exit(0);
}

const out = [];
out.push(`🐴 sawbuck: live suppression debt in ${basename(repo)}`);
out.push(`   ${live.length} still silenced in HEAD  ·  ${testSkips} disabled/weakened test${testSkips === 1 ? '' : 's'} (hidden-failure risk)  ·  ${codeSup} lint/type suppression${codeSup === 1 ? '' : 's'}  ·  ${bare} undocumented (no code/reason)`);
if (onFragile) out.push(`   ${onFragile} of ${files.length} debt-carrying files sit on fragile code (reverts/hotspots); look there first`);
out.push(`\n   highest-risk debt (severity x how fragile the file is):`);
for (const f of files.slice(0, top)) {
  const bits = [f.skips ? `${f.skips} test` : '', f.sup ? `${f.sup} lint/type${f.bareSup ? `, ${f.bareSup} bare` : ''}` : ''].filter(Boolean).join(' + ');
  const frag = [f.reverts ? `${f.reverts} revert${f.reverts === 1 ? '' : 's'}` : '', f.hot ? 'fix-hotspot' : '', (!f.hot && f.fixes >= 3) ? `${f.fixes} fixes` : ''].filter(Boolean).join(', ');
  out.push(`     ${f.reverts || f.hot ? '🔥 ' : '   '}${f.file}  ·  ${f.n} (${bits})${frag ? `  · ${frag}` : ''}  ·  risk ${f.risk}`);
}
const dated = live.filter((it) => it.date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
if (dated.length) {
  out.push(`\n   oldest still-silenced (most stale):`);
  for (const it of dated.slice(0, 5)) out.push(`     ${it.file}:${it.line}  ${String(it.kind).trim()}  (since ${it.date})`);
}
out.push(`\n   bare = no code/reason, the suspect kind. leads, not verdicts; full dated ledger: logbook audit`);
console.log(out.join('\n'));
