#!/usr/bin/env node
// reflect.mjs, the Sawbuck feedback edge.
//
// Run the check (the promptwheel engine) on the latest commit; on a gamed or
// regression result, deterministic ground truth, record a finding in the
// memory (the logbook engine) on the touched source paths, and tick the results
// record. Quiet by default; the Stop hook says a fresh catch once.
//
// Zero-dep, Node ESM. Orchestrates the engine CLIs behind a clean layer
// boundary, never reaching into their source.
//
//   node reflect.mjs [--repo <path>] [--base <ref>] [--head <ref>] [--answer] [--was <metric,metric>]
//   defaults: repo=cwd, base=HEAD~1, head=HEAD   (evaluates the latest commit)
//   --answer  one line of JSON on standard output saying what this run concluded: {"sawbuck":{"gamed":...}}. The
//             end-of-turn hook reads that, and nothing from the record folder, to decide whether a turn is sent back.
//   --gave-back  the hook again: in these commits a test change caught in an earlier turn was put back as it was;
//             the metrics that catch was about. The green it gave was never earned, so losing it is no regression.
//   --was     the hook again: this turn already holds a gamed catch on these metrics, and base..head is all of the
//             turn's commits judged together again (0.2.0). No verdict is carried from one turn to the next.
//
// PW_BIN / LB_BIN override the engines.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { record as memRecord } from './memory.mjs';
import { keptOnTree } from './allowed.mjs';
import { PW } from './bins.mjs';
import { ownGitOn, personEnv } from './own-git.mjs';
ownGitOn();   // when this file is run by itself; under sawbuck it is on already (own-git.mjs)

// Logbook is reached only through memory.mjs, never resolved or shelled directly here.

const flag = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : def; };
const repo = flag('--repo', process.cwd());
const base = flag('--base', 'HEAD~1');
const head = flag('--head', 'HEAD');
const by = flag('--by', '');   // the agent that authored the change (Claude-first: the Claude hook passes 'claude'); empty = unattributed (raw-git path)
const noAuto = process.argv.includes('--no-auto');   // user-level wiring: measure only where a contract exists, never auto-gate a stranger's suite
const wasArg = flag('--was', null);
const gaveBackArg = flag('--gave-back', null);
let answered = false;
const answer = (o) => { if (!process.argv.includes('--answer') || answered) return; answered = true; process.stdout.write(JSON.stringify({ sawbuck: o }) + '\n'); };

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
// backstop so the check can never hang a commit/turn; generous default, overridable.
const CHECK_TIMEOUT = +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 600000;
// A Sawbuck-Allow or Promptwheel-Allow trailer never clears the verdict, whichever hook ran this: the git hook cannot
// tell who made a commit, and an agent can write a commit message. The override is a person running
// `sawbuck check --allow "<reason>"`.
const childEnv = { ...personEnv(), PROMPTWHEEL_NO_ALLOW_TRAILER: '1' };
const runNode = (file, a) => execFileSync(process.execPath, [file, ...a], { cwd: repo, encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT, killSignal: 'SIGKILL' });

// --- 1) the check: measure the commit, parse the structured result ----------
// The check exits nonzero on fail/gamed/inconclusive, but still prints the JSON
// report to stdout, so recover it from the thrown error too.
function check() {
  // A report that cannot be read is no verdict: one that arrived cut (the engine was stopped while it printed; until
  // engine 0.8.16 also any report larger than a pipe holds) used to throw here, from inside the catch below.
  const parse = (out) => { const i = out.indexOf('{'); if (i < 0) return null; try { return JSON.parse(out.slice(i)); } catch { return null; } };
  try {
    return parse(runNode(PW, ['run', '--base', base, '--head', head, '--json', ...(noAuto ? ['--no-auto'] : [])]));
  } catch (e) {
    return parse((e.stdout || '').toString());
  }
}

const report = check();
if (!report || !report.verdict) process.exit(0);          // couldn't measure → nothing to learn
const verdict = report.verdict;                            // engine contract: 'gamed' | 'fail' | ...
// WHAT THE VERDICT WORD LEAVES OUT. The engine answers "fail" when a change touches a protected path or makes a guard
// worse, and "gamed" only when neither is so. A win in the same change that came from editing the test is then in the
// report (a metric marked gamed, a weakened gate) and not in the word. Until 0.1.73 this file read the word, and the
// end of a turn sends back only what is recorded here as gamed. So, with a contract written (its counts are guards), a
// failing test that was deleted or skipped ended the turn with one line and no send-back; and a gamed test committed
// beside a protected path was left to the wall, which sent the turn back for the path, or spared it as the person's
// own, and never read the test (proof-bench/beside-guard and swept-in, 2026-11-16: every version from 0.1.64).
// A gamed win is recorded as gamed whatever else the change holds.
const metrics = report.metrics || [];
const gateWeakened = !!(report.gate && Array.isArray(report.gate.weakened) && report.gate.weakened.length && !report.gate.allowed);
const gamedHere = verdict === 'gamed' || metrics.some((m) => m.gamed === true) || gateWeakened;
const failedGuards = metrics.filter((m) => m.guard && !m.ok).map((m) => m.name);
const protectedHere = (report.mandates || []).length > 0;
// What the engine would answer were no protected path in the change: its own rule (deriveVerdict) without the mandate.
// Under the hooks a protected path is the wall's to send back, or to spare when it was the person's own file committed
// as it was; a gamed verdict is about the metrics.
const nothingCertified = (metrics.some((m) => m.inert) && !metrics.some((m) => m.status === 'improved' && !m.tripwire)) || metrics.some((m) => m.unprovable === true);
const alone = !protectedHere ? verdict : failedGuards.length ? 'fail' : gamedHere ? 'gamed' : nothingCertified ? 'inconclusive' : 'pass';
// The goalposts this span moved, by the engine's own split (promptwheel 0.8.12 on): the paths its source-only re-run
// does not take from the change. null when the engine did not say.
const goalposts = (report.gate && Array.isArray(report.gate.goalposts)) ? report.gate.goalposts : null;
// the results record, and the base this run measured from (a full sha)
const recDir = join(repo, '.sawbuck');
const recPath = join(recDir, 'results.json');
let rec = { regressions: 0, gamed: 0, latest: null };
try { if (existsSync(recPath)) rec = JSON.parse(readFileSync(recPath, 'utf8')); } catch {}
delete rec.settled;   // a field versions before 0.2.0 wrote
let baseSha = ''; try { baseSha = git('rev-parse', `${base}^{commit}`); } catch {}
// the last catch on record was on this same span: counted once, however often the span is judged (an amend under the git hook)
const countedAlready = !!(rec.latest && rec.latest.kind === 'gamed' && rec.latest.base && rec.latest.base === baseSha);
const writeRec = () => { try { mkdirSync(recDir, { recursive: true }); writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n'); } catch {} };
// A person's reason for this very change, given on the working tree before it was committed (allowed.mjs): the commit
// is theirs to have let through. Not where a protected path is in the change (the wall's), and not when the turn's
// commits are being judged again. What needs a reason here is the gamed win, or with nothing gamed the count that got worse.
if (wasArg === null && !protectedHere && (gamedHere || (verdict === 'fail' && failedGuards.length))) {
  const needs = gamedHere ? metrics.filter((m) => m.gamed === true).map((m) => m.name) : failedGuards;
  let headSha = ''; try { headSha = git('rev-parse', `${head}^{commit}`); } catch {}
  let touched = []; try { touched = git('diff', '--name-only', '-z', base, head, '--').split('\0').filter(Boolean); } catch {}
  const posts = goalposts ? goalposts.filter((f) => touched.includes(f)) : touched.filter((f) => /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/|\.config\.|golden|fixture|snapshot)/i.test(f));
  const kept = headSha ? keptOnTree(repo, { base: baseSha, head: headSha, goalposts: posts, needs }) : null;
  if (kept) {
    const at = new Date().toISOString(); const why = `a person let this through before it was committed: ${kept.reason}`;
    rec.latest = { sha: headSha.slice(0, 8), kind: 'allowed', base: baseSha || null, file: posts[0] || '', reason: why.slice(0, 200), at, by: by || null, allowed: { reason: kept.reason, at: kept.at } };
    writeRec(); appendActivity(verdict, report, false, { kind: 'allowed', file: posts[0] || '', reason: why });
    process.stderr.write(`sawbuck: let through by a person's reason, given before the commit (${posts[0] || 'this change'})\n`);
    answer({ gamed: false, allowed: true });
    process.exit(0);
  }
}
// A TEST CHANGE CAUGHT IN AN EARLIER TURN WAS PUT BACK IN THESE COMMITS (0.2.0). The hook says so, with the metrics that
// catch was about. Judged by themselves these commits read "made worse": the suite was green only by the changed test,
// and with the test back it is as red as it was before the catch. That is the person's second way out being taken, not
// a regression, so it is recorded as the test put back and counted as no catch. Only when nothing else got worse.
const worse = metrics.filter((m) => (m.guard && !m.ok) || m.status === 'regressed').map((m) => m.name);
const gaveBack = gaveBackArg === null ? [] : gaveBackArg.split(',').filter(Boolean);
if (gaveBack.length && !gamedHere && !protectedHere && verdict === 'fail' && worse.length > 0 && worse.every((n) => gaveBack.includes(n))) {
  let headSha = ''; try { headSha = git('rev-parse', head); } catch {}
  let touched = []; try { touched = git('diff', '--name-only', '-z', base, head, '--').split('\0').filter(Boolean); } catch {}
  const file = (goalposts || []).find((f) => touched.includes(f)) || touched[0] || '';
  const why = 'a test change caught in an earlier turn was put back; the green it gave went with it, and that is not a regression';
  rec.latest = { sha: headSha.slice(0, 8), kind: 'put back', base: baseSha || null, file, reason: why, at: new Date().toISOString(), by: by || null, takenBack: true };
  writeRec(); appendActivity(verdict, report, false, { kind: 'note', file, reason: why });
  answer({ gamed: false, how: 'put back' });
  process.exit(0);
}
appendActivity(verdict, report, wasArg !== null);   // the event feed logs EVERY measurable check, so you can watch it work (verified too, not only catches)
if (wasArg !== null) {
  // THE TURN'S COMMITS, JUDGED AGAIN. The turn was sent back for a gamed win, and this is every commit it has made,
  // together, from where it began. Three answers: the source earned it; the test was put back; or it is still gamed.
  let headSha = ''; try { headSha = git('rev-parse', head); } catch {}
  const was = wasArg.split(',').filter(Boolean);
  const put = (kind, reason, more = {}) => { rec.latest = { sha: headSha.slice(0, 8), kind, base: baseSha, file: (rec.latest && rec.latest.file) || '', reason, at: new Date().toISOString(), by: by || null, ...more }; writeRec(); };
  // The metrics the catch was about, by name. It is earned when THOSE are a win again and the source-only re-run
  // carries it. The engine's "pass" alone is not that: it does not let a guard that is red at both ends bury a real win
  // elsewhere, so with the gamed test still edited, the suite broken again and another metric improved from the
  // source, the word over the span was "pass" and the weakened test stood (proof-bench/beside-guard/second-metric.sh,
  // every version before 0.1.73; only in a contract with a second metric that has its source check on). A catch that
  // names no metric (a weakened gate with no gamed metric) cannot say, and takes the engine's pass.
  const earned = (m) => m.status === 'improved' && m.gamed === false;
  const allEarned = was.length > 0 && !gamedHere && !metrics.some((m) => m.unprovable === true) && was.every((n) => metrics.some((m) => m.name === n && earned(m)));
  if (allEarned || (alone === 'pass' && was.length === 0)) {
    // What else the turn's commits hold is not this catch's business: a protected path still changed is the wall's
    // under the hooks (or the person's own file), and a count that got worse (the failing test is still deleted) is a
    // regression like any other, recorded below and said once.
    put('verified', alone === 'pass' ? 'the source earned the green over this turn\'s commits' : 'the source earned the green over this turn\'s commits; what else they made worse is recorded on its own');
    answer({ gamed: false, how: 'earned' });
    if (verdict === 'pass') process.exit(0);
  } else if (!gamedHere && goalposts && goalposts.length === 0) {
    // the test was put back: these commits move no goalpost any more, so there is no win here to doubt. With the suite
    // red as it was before, the engine can certify nothing ("inconclusive"); what the commits hold now is an ordinary
    // change, read below like any other.
    put('put back', 'the test change was taken back: these commits move no test, config or grader any more', { takenBack: true });
    answer({ gamed: false, how: 'put back' });
  } else {
    // gamed again, commits that cannot be certified with the test still edited, or a pass that came from another metric
    // while this one won nothing: the source has not earned the green. The hook keeps its catch, and nothing is counted
    // or noted a second time.
    answer({ gamed: true, again: true });
    process.stderr.write(`sawbuck: the gamed win in this turn's commits is still there (${verdict} over all of them)\n`);
    process.exit(0);
  }
}
if (!gamedHere && verdict !== 'fail') { answer({ gamed: false }); process.exit(0); }   // only breakage is worth recording
// A fail that is only a protected path, under the hooks: the Stop hook's wall counts it and sends the turn back, so
// counting it here too would show two catches for one change. The git hook has no wall, so it records it. Only when
// nothing in the same change is gamed: the wall does not read a test.
if (!gamedHere && by && protectedHere && !failedGuards.length) { answer({ gamed: false }); process.exit(0); }

// map the engine's report to Sawbuck's plain outcome words
const kind = gamedHere ? 'gamed' : 'regression';

// --- 2) build the finding from the result ----------------------------------
const sha = git('rev-parse', head);
const changed = git('diff', '--name-only', '-z', base, head, '--').split('\0').filter(Boolean);
const testish = (f) => /(\.test\.|\.spec\.|__tests__|\/tests?\/|\.config\.|golden|fixture|snapshot)/i.test(f);
const srcFiles = changed.filter((f) => !testish(f));
// a gamed win is named by the goalpost that moved (a test first, then config or a golden file); a regression by the source
const isTest = (f) => /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/)/i.test(f);
// a protected path that was touched is the finding, whatever else the change did: name the rule and the file
const hit = kind === 'regression' ? protectedHit(report) : null;
// a gamed win is named by a goalpost the engine says moved, when it says; a protected path in the same change is never
// the name for it unless nothing else changed (the contract edited to weaken the check is both)
const prot = new Set((report.mandates || []).flatMap((m) => (m && m.files) || []));
const moved = (goalposts || []).filter((f) => changed.includes(f));
const beside = changed.filter((f) => !prot.has(f));
const firstTest = (list) => list.find(isTest) || list.find(testish);
const evidenceFile = kind === 'gamed' ? (firstTest(moved.filter((f) => !prot.has(f))) || firstTest(beside) || moved[0] || beside[0] || changed[0]) : hit ? hit.file : (srcFiles[0] || changed[0]);
if (!evidenceFile) { answer({ gamed: gamedHere }); process.exit(0); }

const gamedMetric = metrics.find((m) => m.gamed === true);
// with no wall to say it (the git hook), a protected path touched in the same change stays in the reason
const alsoProtected = (kind === 'gamed' && !by) ? protectedHit(report) : null;
const reason = kind === 'gamed'
  ? `sawbuck: a change here was gamed, ${gamedMetric?.gamingReason || (gateWeakened ? 'the check itself was weakened in the same change' : 'a metric "improved" by weakening its test, not the source')}${alsoProtected ? `; the same change ${alsoProtected.why}` : ''}`
  : hit ? `sawbuck: a change here ${hit.why}`
  : `sawbuck: a change here regressed a guarded metric beyond noise`;

// --- 3) record the finding in memory (unreviewed, machine-authored note) ----
// A note on the commit, through the Logbook adapter. A turn's commits judged again never get here with a catch (that
// exited above), and the same span judged twice is counted once, so one catch is one note and one tick.
const again = kind === 'gamed' && countedAlready;
if (!again) memRecord(repo, { sha, reason: reason.slice(0, 280), by: 'sawbuck' });

// --- 4) tick the results record (the visible proof-of-work) -----------------
if (again) { /* counted when it was first caught */ } else if (kind === 'gamed') rec.gamed += 1; else rec.regressions += 1;
rec.latest = { sha: sha.slice(0, 8), kind, base: baseSha || null, file: evidenceFile, reason: reason.replace(/^sawbuck: /, '').slice(0, kind === 'gamed' && alsoProtected ? 280 : 140), at: new Date().toISOString(), by: by || null,
  ...(kind === 'gamed' ? { metrics: metrics.filter((m) => m.gamed === true).map((m) => m.name).slice(0, 8) } : {}),
  // every goalpost the change moved (the Stop hook compares the working tree with them; `goalpostsMore` when the list was cut)
  ...(kind === 'gamed' && moved.length ? { goalposts: moved.slice(0, 50), ...(moved.length > 50 ? { goalpostsMore: true } : {}) } : {}), ...(kind === 'gamed' && failedGuards.length ? { also: failedGuards.slice(0, 8) } : {}) };
writeRec();
answer(kind === 'gamed' ? { gamed: true, base: baseSha, file: evidenceFile, reason: rec.latest.reason, metrics: rec.latest.metrics || [], goalposts: rec.latest.goalposts, goalpostsMore: rec.latest.goalpostsMore, also: rec.latest.also } : { gamed: false, regression: true });

// --- 5) quiet by default; one line to stderr -
process.stderr.write(`sawbuck: ${kind} recorded on ${evidenceFile}\n`);

// the first protected path (mandate) the engine reports as touched, in words
function protectedHit(rep) {
  const m = (rep.mandates || []).find((x) => x && (x.files || []).length);
  return m ? { file: m.files[0], why: `touched the protected path "${m.name}": ${m.files.slice(0, 3).join(', ')}${m.files.length > 3 ? `, and ${m.files.length - 3} more` : ''}` } : null;
}

// --- the activity feed: one line per check so you can watch it work, verified
// included, not only catches. Capped, lives in the git-excluded .sawbuck/, opt
// out with SAWBUCK_NO_LOG=1. `sawbuck status --log` reads it.
function appendActivity(v, rep, again = false, as = null) {
  if (process.env.SAWBUCK_NO_LOG) return;
  const map = { pass: 'verified', gamed: 'gamed', fail: 'regression', inconclusive: 'inconclusive' };
  // no hook passes --allow and a trailer clears nothing; "allowed" is logged only for a reason a person gave on the
  // working tree before the commit (`as`, from the caller)
  const k = as ? as.kind : gamedHere ? 'gamed' : map[v];
  if (!k) return;
  let sha = '', file = '';
  try { sha = git('rev-parse', head).slice(0, 8); } catch {}
  const hit = k === 'regression' ? protectedHit(rep) : null;
  try { file = (hit && hit.file) || git('diff', '--name-only', '-z', base, head, '--').split('\0').filter(Boolean)[0] || ''; } catch {}
  const gm = (rep.metrics || []).find((m) => m.gamed === true);
  if (k === 'gamed') { const names = (rep.gate && Array.isArray(rep.gate.goalposts)) ? rep.gate.goalposts : []; if (names.length) file = names.find((f) => /(\.test\.|\.spec\.|__tests__|(^|\/)tests?\/)/i.test(f)) || names[0]; }
  const why = k === 'gamed' ? (gm?.gamingReason || 'the win came from editing the goalposts')
    : k === 'regression' ? (hit ? `the change ${hit.why}` : 'a guarded metric regressed beyond noise')
    : k === 'verified' ? 'the check passed'
    : 'could not certify a pass';
  // `again`: this check judged a turn's commits again after a catch, not a new catch
  const ev = { at: new Date().toISOString(), kind: k, sha, file: (as && as.file) || file, reason: String((as && as.reason) || why).slice(0, 160), by: by || null, ...(again ? { again: true } : {}) };
  const dir = join(repo, '.sawbuck');
  const p = join(dir, 'activity.jsonl');
  try {
    mkdirSync(dir, { recursive: true });
    let lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
    lines.push(JSON.stringify(ev));
    if (lines.length > 200) lines = lines.slice(-200);
    writeFileSync(p, lines.join('\n') + '\n');
  } catch {}
}
