#!/usr/bin/env node
import { ensureExcluded } from './exclude.mjs';
import { shareFinding } from './share.mjs';
// sawbuck-hook.mjs: the Sawbuck Claude Code Stop-hook entry.
// Each turn: if a new commit landed, run reflect on it; then say so once on a fresh catch. State in .sawbuck/state.json.
// Zero-dep. Usage (wired as a Stop hook): node sawbuck-hook.mjs --repo <path>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
import { mandateHits, hashOf, hashFollowing, hashRaw, isLink, protectedAmong, lockState, sinceBegan, stateOf, stateAt, sameState, branchOf } from './contract.mjs';
import { dependencyEditsSince, dependencyNotice } from './deps.mjs';
import { readGuard, writeGuard, clearGuard, OWN, ownOf } from './guard.mjs';
import { beganWithoutRepo, forgetBegan } from './began.mjs';
import { readAllowed, keptOnTree } from './allowed.mjs';
import { cli, olderSaid } from './copies.mjs';
import { undoJudge, redoJudge, redoDue, redoTold, redoLine, undoHintNote, undoHintDue, undoHintTold } from './undo.mjs';
import { ownGitOn } from './own-git.mjs';
ownGitOn();   // when this file is run by itself; under sawbuck it is on already (own-git.mjs)
const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const by = flag('--by', '');   // attribution from the harness wiring: the Claude hook passes 'claude', the raw-git hook passes nothing
// nothing this hook finds is handed on to any notes unless the repo is attached with --words (share.mjs reads this)
if (!process.argv.includes('--words')) process.env.SAWBUCK_SHARE = 'none';
const stop = process.argv.includes('--stop');   // wired as the Claude Code Stop hook: enforce the contract on a gamed turn
// user-level wiring passes no --repo: the hook runs in whatever cwd the session has, so it resolves the
// repository root itself (a subdirectory belongs to its repo) and leaves a non-repository alone: no
// state, no exclude block, nothing written where there is nothing to verify.
const userMode = !process.argv.includes('--repo');
const sh = (cwd, ...a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const repo = flag('--repo', '') || sh(process.cwd(), 'rev-parse', '--show-toplevel') || process.cwd();
const git = (...a) => sh(repo, ...a);
if (!git('rev-parse', '--git-dir')) process.exit(0);
let hookInput = {};
if (stop) { try { hookInput = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {} }   // the Stop hook's JSON on stdin (stop_hook_active, prompt_id, ...)
ensureExcluded(repo);   // keep the record out of git status under ANY attach mode (incl. --user)

const CHECK_TIMEOUT = +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 600000;   // never hang a turn
const node = (f, a) => { try { return execFileSync(process.execPath, [f, ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT, killSignal: 'SIGKILL' }); } catch (e) { return (e.stdout || '').toString(); } };

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(repo, 'sawbuck.config.json'), 'utf8')); } catch {}

const stDir = join(repo, '.sawbuck');
const stPath = join(stDir, 'state.json');
let st = { lastSha: '', turns: 0, shownTotal: 0 };
// read once, and known to be a real state: a file that is gone, blank or garbled is not one (see the guard, below)
let stateRead = false;
try { if (existsSync(stPath)) { const s = JSON.parse(readFileSync(stPath, 'utf8')); if (s && typeof s === 'object' && !Array.isArray(s)) { st = s; stateRead = true; } } } catch {}

// 1) new commit(s) in this turn → run the check on all of the turn's commits together. A follow-up commit (an
// amend, an empty commit, unrelated work) cannot clear a catch: it is judged with the commit it follows, from where
// the turn began. Under user-level wiring the check runs only where a contract exists (--no-auto): nobody's whole
// test suite runs three times in a repo they never set up.
const head = git('rev-parse', 'HEAD');
const readRec = () => { try { return JSON.parse(readFileSync(join(stDir, 'results.json'), 'utf8')); } catch { return null; } };
const writeRec = (r) => { try { mkdirSync(stDir, { recursive: true }); writeFileSync(join(stDir, 'results.json'), JSON.stringify(r, null, 2) + '\n'); } catch {} };
// schema 1 (reflect.mjs says what the fields are): the session, the caller (this hook: `harness`) and the full head, beside what each line says
const sessionOf = String(hookInput.session_id || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80);
const logActivity = (ev) => { try { mkdirSync(stDir, { recursive: true }); const { sha, ...rest } = ev; appendFileSync(join(stDir, 'activity.jsonl'), JSON.stringify({ schema: 1, at: new Date().toISOString(), ...(sessionOf ? { session: sessionOf } : {}), caller: 'harness', ...(head ? { head } : {}), ...(sha !== undefined ? { sha } : {}), ...rest }) + '\n'); } catch {} };
const hasCommit = (ref) => { try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } };
let rec = readRec();
// the span re-proved is the TURN's: from the commit HEAD was at when the prompt began (the turn baseline) to HEAD now. Commits
// the person made between turns (a red test first, a merge, a pull) are theirs, not the agent's, and are not scored; a
// standing gamed verdict keeps its own base below. The first turn after attach has no baseline yet and starts from lastSha.
const isAncestor = (a, b) => { try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; } };
// THE RECORD IS NOT THE ONLY WITNESS (the end-of-turn hook only; guard.mjs says why). Two things are kept a second time
// in the git folder: the baseline the prompt hook took, and a gamed verdict this hook sent back.
const enforcing = stop && !process.env.SAWBUCK_NO_ENFORCE;
const G = readGuard(repo);   // read in every mode: what this hook counts lives there (`own`), whoever runs it
const guard = enforcing ? G : {};
const inHead = (sha) => !!(sha && head && hasCommit(sha) && (sha === head || isAncestor(sha, head)));
// 1) the state file is not the one this turn began with. The prompt hook writes it on every prompt, with the time of
// the prompt, and writes the guard's baseline in the same breath. So a state file that is gone, blank, garbled, or
// older than the guard's baseline was removed or replaced during the turn. Nothing in it is believed: the turn is
// checked from the commit it began at, with the baseline it began with.
let recordRemoved = false;
const stateUsable = stateRead && !!st.lastPromptAt && !(guard.baseline && guard.baseline.at && Date.parse(st.lastPromptAt) < Date.parse(guard.baseline.at));
// With or without a commit (0.2.6): a baseline taken where there was none names no commit (sha ''), and until then the
// second copy was passed over there, so the state file alone decided where such a turn began (no-baseline, D1, D2).
const guardBase = (guard.baseline && typeof guard.baseline === 'object' && !Array.isArray(guard.baseline) && typeof guard.baseline.sha === 'string') ? guard.baseline : null;
if (enforcing && guardBase && (guardBase.sha === '' || hasCommit(guardBase.sha))) {
  if (!stateUsable) {
    st = { lastSha: guard.baseline.sha, turns: 0, shownTotal: 0 }; st.lastPromptAt = guard.baseline.at || st.lastPromptAt; recordRemoved = true;
    logActivity({ kind: 'note', sha: (head || '').slice(0, 8), file: '', reason: 'the record under .sawbuck/ was removed or made unreadable during the turn; it was rebuilt, and the turn is checked again from the commit it began at', by: by || 'hook' });
  }
  // 1b) a state file that reads well is not believed for where the turn began either. One field edited there (the
  // baseline's commit set to the gamed commit, or that commit added to its list of tips) ended a turn with nothing
  // looked at, and no line in git status (record-tamper, 2026-11-13). The baseline that counts is the second copy's,
  // whole: its commit, its tips, the files already dirty, the lock, the rules, the send-backs the repo allowed.
  st.turnBaseline = guard.baseline;
}
// 1c) what this hook itself counts is read from the second copy in every mode, not from the state file: the last
// commit it looked at (set that to the gamed commit and nothing was checked), and how many times this prompt was sent
// back (set that to its limit and the turn was not sent back at all). The state file keeps a copy for `status` and the
// band; nothing here is decided by it once the second copy holds these.
const own = (G.own && typeof G.own === 'object' && !Array.isArray(G.own)) ? G.own : null;
if (own) {
  for (const k of OWN) { if (Object.prototype.hasOwnProperty.call(own, k)) st[k] = own[k]; else delete st[k]; }
  st.lastSha = (own.seen && hasCommit(own.seen)) ? own.seen : '';
}
// 0) THE UNDO LEDGER, WHEN THE TURN ENDS (undo.mjs). What the agent had added to a file when the person spoke, and is gone
// now, is an undo at their request, whatever took it out: an edit, `git checkout`, a shell command. Their words go
// with it only where the repo is attached with --words (the state file holds none otherwise), and so does the note.
if (stop) {
  for (const e of undoJudge(repo, hookInput.session_id, st.lastPrompt || '')) {
    await shareFinding(repo, { kind: 'undone', title: `${e.kind === 'part' ? 'partly undone' : 'undone'}: ${e.first || e.file} in ${e.file}`, text: e.why || `An edit to ${e.file} was undone at the person's request.`, files: [e.file] }).catch(() => {});
    // recorded without its reason (no words are kept here): the person is told so, once in a session, below
    if (by === 'claude' && !process.argv.includes('--words')) undoHintNote(repo, hookInput.session_id, e);
  }
  // and what was undone before and is in its file again since the person spoke: recorded here, told below
  redoJudge(repo, hookInput.session_id, { end: true });
}

// 2) WHAT IS STILL OPEN (0.2.0). A gamed win this hook caught that nothing has settled. Kept as a short list in the
// second copy and never read from the record folder. NO VERDICT IS CARRIED FROM ONE TURN TO THE NEXT: a catch is sent
// back only in the turn that made it (`mine`, below), and after that turn the person is told about it for a few turns
// (enforce.remindTurns, 5) and nothing is sent back for it. Until this version one gamed verdict "stood" over every
// later turn until its span re-proved, each rule for how it came down was a place to get that wrong, and a wrong one
// sent every later turn back; on 2026-11-16 six of seven fixes were to those rules. The worst a wrong rule can do
// now is three send-backs in one turn.
// An item leaves the list three ways: its commit left this history; a person's reason is on record for it; or the
// test is back as it was (every goalpost it moved reads at HEAD as it did where the catch began).
const turnOpenNow = stop && !!(own && own.turnOpen);   // a prompt began this turn (the prompt hook says so in the second copy)
// `live`: the catch this hook is in the middle of sending back. Set when it is caught, taken off when the turn ends.
const KEPT = ['sha', 'base', 'file', 'reason', 'at', 'by', 'metrics', 'goalposts', 'goalpostsMore', 'also', 'live', 'told', 'toldTurn'];
const asItem = (o) => { const out = {}; for (const k of KEPT) if (o && o[k] !== undefined && o[k] !== null) out[k] = o[k]; return out; };
let open = (Array.isArray(G.open) ? G.open : []).filter((o) => o && typeof o === 'object' && typeof o.sha === 'string' && typeof o.base === 'string' && o.sha && o.base).map(asItem);
// a verdict a version before 0.2.0 left standing is an open item from an earlier turn
if (G.standing && typeof G.standing === 'object' && G.standing.sha && G.standing.base && !open.some((o) => o.sha === G.standing.sha)) open.push(asItem({ ...G.standing, live: false }));
const openWas = JSON.stringify(open);
const same = (...a) => { try { execFileSync('git', ['-C', repo, 'diff', '--quiet', ...a], { stdio: 'ignore' }); return true; } catch { return false; } };
const acceptedFor = (o) => {
  const lets = (e) => (e.cleared || []).some((l) => !String(l).startsWith('mandate:'));
  const oneCommit = () => git('rev-parse', '--verify', '-q', `${o.sha}^`) === o.base;
  // a reason given for a commit or a span counts when that span begins where the catch began and holds its commit; an
  // entry from before 0.1.73 says no base, and counts only for a catch that is one commit
  const kept = readAllowed(repo).find((e) => e.sha && lets(e) && (e.base ? (e.base === o.base && (String(o.sha).startsWith(e.sha) || isAncestor(o.sha, e.sha))) : (String(o.sha).startsWith(e.sha) && oneCommit())));
  // and one given on the working tree, before the commit, counts for the commit that carries the same change (allowed.mjs)
  return kept || keptOnTree(repo, { base: o.base, head: o.sha, goalposts: Array.isArray(o.goalposts) ? o.goalposts : [], needs: Array.isArray(o.metrics) ? o.metrics : [] });
};
const putBack = (o) => Array.isArray(o.goalposts) && o.goalposts.length > 0 && !o.goalpostsMore && same(o.base, 'HEAD', '--', ...o.goalposts);
const gaveBack = [];   // the metrics of a catch from an earlier turn whose test is back as it was: said to reflect.mjs, below
open = open.filter((o) => {
  if (!(inHead(o.sha) && hasCommit(o.base))) return false;   // reset or rebased away, or its base pruned: nothing left to settle
  const yes = acceptedFor(o);
  // this turn's own catch is settled by the engine, on all of the turn's commits (below). An earlier turn's is not
  // judged again: it is settled when the test reads as it did before.
  const isMine = !!(enforcing && o.live);
  const how = yes ? 'a person accepted it' : (!isMine && putBack(o)) ? 'the test is back as it was' : '';
  if (!how) return true;
  logActivity({ kind: 'note', sha: (head || '').slice(0, 8), file: o.file || '', reason: `a gamed change caught earlier is settled: ${how}`, by: by || 'hook' });
  // the record says so too, for `status` and the band
  const latestIsIt = rec && rec.latest && rec.latest.kind === 'gamed' && String(o.sha).startsWith(String(rec.latest.sha || '-'));
  if (yes && latestIsIt) { rec.latest = { ...rec.latest, kind: 'allowed', allowed: { reason: yes.reason, at: yes.at } }; writeRec(rec); }
  if (!yes) { gaveBack.push(...(Array.isArray(o.metrics) ? o.metrics : [])); if (latestIsIt) { rec.latest = { ...rec.latest, kind: 'put back', takenBack: true, reason: 'the test change was taken back: the test reads as it did before', at: new Date().toISOString() }; writeRec(rec); } }
  return false;
});
// this turn's own catch, when it has one: the only thing a turn is sent back for
let mine = enforcing ? (open.find((o) => o.live) || null) : null;
// The record's latest line says gamed and the list does not hold that catch (a record from before the second copy, one
// written by hand, or a catch that is settled): nothing is decided by that line, so it must not keep saying it.
if (rec && rec.latest && rec.latest.kind === 'gamed' && !open.some((o) => String(o.sha).startsWith(String(rec.latest.sha || '-')))) {
  logActivity({ kind: 'note', sha: (head || '').slice(0, 8), file: rec.latest.file || '', reason: 'the record said gamed for a change nothing here holds open any more; the line is cleared, and new commits are checked as always', by: by || 'hook' });
  rec.latest = { ...rec.latest, kind: 'unverified', at: new Date().toISOString(), reason: 'a gamed line with no open catch behind it' };
  writeRec(rec);
}
// WHAT A REMOTE BROUGHT IN DURING THE TURN STAYS THE REMOTE'S; WHAT THIS CLONE PUSHED THERE IS STILL THE AGENT'S OWN.
// Until 0.1.74 every commit on any remote branch was left out of the turn's own commits. So a commit the agent made and
// pushed in the same turn was read as someone else's, and the turn ended with nothing checked ("commit and push":
// typed for the first time on 2026-11-17; every version from 0.1.57). git says which it was, in the log it keeps for
// each remote branch: "update by push" for a push from this clone, "fetch ..." or "pull ..." for what came in.
// A remote branch that did not move since the turn began is already left out as one of the turn's tips. One that
// moved and has no log here (a clone that keeps none) is left out whole, as before. Returns arguments for rev-list.
// --no-show-signature: with log.showSignature set, a look at a log starts gpg once for every entry it shows.
const fromRemotes = (tips, sinceIso) => {
  const since = Math.floor(Date.parse(sinceIso || '') / 1000);
  if (!tips.length || !Number.isFinite(since)) return ['--not', '--remotes'];
  const had = new Set(tips); const out = [];
  for (const line of git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes').split('\n').filter(Boolean)) {
    const sp = line.indexOf(' '); const sha = line.slice(0, sp), ref = line.slice(sp + 1);
    if (had.has(sha)) continue;
    const moves = git('log', '--no-show-signature', '-g', '--date=unix', '--format=%H %gd %gs', ref, '--').split('\n')
      .map((l) => /^([0-9a-f]+) .*@\{(\d+)\} (.*)$/.exec(l)).filter(Boolean).map((m) => ({ sha: m[1], at: +m[2], how: m[3] })).filter((e) => e.at >= since);
    if (!moves.length) { out.push(`^${sha}`); continue; }
    for (const e of moves) if (!e.how.startsWith('update by push')) out.push(`^${e.sha}`);
  }
  return out;
};
// THE TURN'S OWN COMMITS, JUDGED TOGETHER (0.2.0). From the commit the turn began at (the baseline the prompt hook took)
// to HEAD, whenever HEAD has moved since this hook last looked. Commits the person made between turns (a red test
// first, a merge, a pull) are before that commit and are not scored. Until this version a second look in one turn
// judged only the commits since the first, and a gamed verdict kept an older span of its own. A turn no prompt began,
// and the git hook, have no beginning on record: there the commits since the last look are judged.
const tb = (st.turnBaseline && st.turnBaseline.sha) || '';
const seen = st.lastSha || '';
const from = (turnOpenNow && tb) ? tb : (seen || tb || '');
// what reflect.mjs concluded in this run, from its own standard output: nothing an agent can write is read for it
const answerOf = (out) => { for (const l of String(out || '').split('\n').reverse()) { if (l.startsWith('{"sawbuck":')) { try { return JSON.parse(l).sawbuck || null; } catch { return null; } } } return null; };
if (head && from && head !== from && head !== seen) {
  // a rebase or a reset inside the turn: HEAD no longer descends from `from`, and the span from..head would blame
  // upstream's commits on the agent (an upstream test edit read as the agent's gamed green). Re-prove only the commits
  // that are new since the turn began and came from no remote: the agent's own, replayed on top. Nothing new means the
  // agent only rebased, and there is nothing of its own to re-prove.
  // The agent's own commits = new since the turn began, not reachable from any ref tip that existed at the turn's start,
  // and not brought in from a remote during the turn (fromRemotes, above). In a plain turn that is exactly from..head.
  // After a rebase or a merge of upstream inside the turn, it is the agent's commits replayed on top, and upstream's
  // commits (an upstream test edit among them) stay upstream's.
  // Merge commits themselves are not re-proved: the span starts at the agent's first own non-merge commit.
  let base = from; let skip = false;
  const tips = (st.turnBaseline && Array.isArray(st.turnBaseline.refs)) ? st.turnBaseline.refs : [];
  let mineOwn = git('rev-list', '--no-merges', head, `^${from}`, ...tips.map((t) => `^${t}`), ...fromRemotes(tips, st.turnBaseline && st.turnBaseline.at), '--').split('\n').filter(Boolean);
  // a rebase replays commits that existed before the turn under new shas (the person's own branch commits among them);
  // a replayed commit is patch-equivalent to one reachable from a recorded tip, and `git cherry` marks those "-"
  if (mineOwn.length && tips.length) {
    for (const t of tips) {
      const fresh = new Set(git('cherry', t, head).split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim()));
      mineOwn = mineOwn.filter((c) => fresh.has(c));
      if (!mineOwn.length) break;
    }
  }
  if (!mineOwn.length) { logActivity({ kind: 'note', sha: head.slice(0, 8), file: '', reason: 'the commits this turn added came from elsewhere (a rebase, a merge, a fast-forward); none is the agent\'s own, nothing to re-prove', by }); skip = true; }
  else base = git('rev-parse', `${mineOwn[mineOwn.length - 1]}^`).trim() || from;
  // a turn that already holds a catch is judged again from where that catch began, whatever else is known of the
  // turn's beginning (a session with no prompt on record has only the last commit looked at, and that is the catch)
  if (mine && hasCommit(mine.base) && isAncestor(mine.base, head)) { base = mine.base; skip = false; }
  if (!skip) {
    // `--was`: this turn already holds a catch, and these are its commits judged again with what came after it. The
    // metrics that catch was about come from the second copy, not from the record.
    const ran = answerOf(node(join(HERE, 'reflect.mjs'), ['--repo', repo, '--base', base, '--head', head, '--answer', ...(mine ? ['--was', (Array.isArray(mine.metrics) ? mine.metrics : []).join(',')] : []), ...(gaveBack.length ? ['--gave-back', [...new Set(gaveBack)].join(',')] : []), ...(by ? ['--by', by] : []), ...(userMode ? ['--no-auto'] : []), ...(hookInput.session_id ? ['--session', String(hookInput.session_id)] : [])]));
    if (ran && ran.gamed) {
      const at = new Date().toISOString();
      const item = (ran.again && mine) ? { ...mine, sha: head, at }
        : asItem({ sha: head, base: ran.base || git('rev-parse', `${base}^{commit}`) || base, file: ran.file || '', reason: ran.reason || '', at, by: by || null, metrics: ran.metrics, goalposts: ran.goalposts, goalpostsMore: ran.goalpostsMore, also: ran.also, live: enforcing });
      // a new catch on the same test files takes the place of an older one still open: the test is judged as it reads now
      const posts = (o) => JSON.stringify((Array.isArray(o.goalposts) && o.goalposts.length) ? [...o.goalposts].sort() : [o.file || '']);
      open = open.filter((o) => o !== mine && o.sha !== item.sha && posts(o) !== posts(item)); open.push(item);
      mine = item.live ? item : null;
    } else if (ran && mine) { open = open.filter((o) => o !== mine); mine = null; }   // the engine's own answer over all of the turn's commits: no gamed win is left in them
  }
  rec = readRec();
}
// the list is kept in the second copy, and a copy of it in the record for `status` and the band. The record's latest
// line says this turn's catch while there is one, whatever was written there meanwhile.
open = open.slice(-5);
if (JSON.stringify(open) !== openWas || G.standing) writeGuard(repo, { open: open.length ? open : null, standing: null });
{ // the record's copy, written whenever it does not say what the list says (the record may have been removed meanwhile)
  const copy = open.map((o) => ({ sha: String(o.sha).slice(0, 8), base: o.base, file: o.file || '', at: o.at || null, ...(Array.isArray(o.goalposts) && o.goalposts.length ? { goalposts: o.goalposts.slice(0, 6) } : {}) }));
  if (JSON.stringify((rec && Array.isArray(rec.open)) ? rec.open : []) !== JSON.stringify(copy)) {
    const r = { regressions: 0, gamed: 0, latest: null, ...(rec && typeof rec === 'object' ? rec : {}) };
    if (copy.length) r.open = copy; else delete r.open;
    writeRec(r); rec = r;
  }
}
const names = (o) => JSON.stringify([o && o.kind, o && o.sha, o && o.base, o && o.file, (o && o.metrics) || null, (o && o.goalposts) || null]);
if (mine && names(rec && rec.latest) !== names({ kind: 'gamed', ...mine, sha: String(mine.sha).slice(0, 8) })) {
  // not the same catch with a newer commit on it: the record was rewritten, or removed, outside sawbuck. It is display
  // only now (nothing here is decided by it), and it is put right so `status` and the band do not say otherwise.
  if (!(rec && rec.latest && rec.latest.kind === 'gamed' && rec.latest.base === mine.base)) logActivity({ kind: 'note', sha: (head || '').slice(0, 8), file: mine.file || '', reason: 'the record of a gamed catch was changed outside sawbuck; it was put back from the second copy, and the turn is still sent back for it', by: by || 'hook' });
  const r = { regressions: 0, gamed: 0, ...(rec && typeof rec === 'object' ? rec : {}) };
  r.latest = { sha: String(mine.sha).slice(0, 8), kind: 'gamed', base: mine.base, file: mine.file || '', reason: mine.reason || 'a win that came from editing the test, not the source', at: mine.at || new Date().toISOString(), by: mine.by || null, ...(mine.metrics ? { metrics: mine.metrics } : {}), ...(mine.goalposts ? { goalposts: mine.goalposts } : {}), ...(mine.goalpostsMore ? { goalpostsMore: true } : {}), ...(mine.also ? { also: mine.also } : {}) };
  if (!r.gamed) r.gamed = 1;
  writeRec(r); rec = r;
}
st.lastSha = head || st.lastSha;
st.turns += 1;

// 2) the record of what the check has charted (read above, after any re-run)
const total = rec ? (rec.regressions || 0) + (rec.gamed || 0) + (rec.mandates || 0) : 0;
// how: 'ends' when this run lets the turn end, 'back' when it sends the turn back, nothing for a save on the way.
// Each save writes what this hook counts to the second copy too. A detach that arrived while the turn was open takes
// the second copy away here, when the turn ends, and not before.
const saveState = (how) => {
  try { mkdirSync(stDir, { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n'); } catch {}
  if (stop && how === 'ends' && open.some((o) => o.live)) { for (const o of open) delete o.live; writeGuard(repo, { open }); }
  if (stop && how === 'ends' && G.detached) { clearGuard(repo); return; }
  const was = !!(own && own.turnOpen);
  writeGuard(repo, { own: { ...ownOf(st), turnOpen: !stop ? was : how === 'ends' ? false : how === 'back' ? true : was } });
};
// the budget is per prompt: prompt_id when the harness sends one, else the prompt's own timestamp (written by
// `sawbuck turn --hook`), never a constant that would spend it for good
const promptId = hookInput.prompt_id || st.lastPromptAt || 'none';
// Send the turn back, at most enforce.maxBlocks times per prompt, then let it end with a warning: it can never
// loop, because the harness's own block cap resets on every tool call.
// the agent's last words this turn: Claude Code passes them, or they are read from the end of the transcript
const lastAgentText = () => {
  if (typeof hookInput.last_assistant_message === 'string') return hookInput.last_assistant_message;
  try {
    const p = hookInput.transcript_path; if (!p) return '';
    const lines = readFileSync(p, 'utf8').slice(-400000).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e && e.type === 'assistant') { const t = ((e.message && e.message.content) || []).filter((x) => x && x.type === 'text').map((x) => x.text).join('\n'); if (t.trim()) return t; }
    }
  } catch {}
  return '';
};
// a question to the person about the test: a question mark near the end, and the test named
const asksPerson = (text, file) => { const tail = String(text || '').slice(-800); return tail.includes('?') && (tail.includes(basename(file || '')) || /\btests?\b/i.test(tail)); };
// the wall's own send-back (0.2.9): how often is decided by what it already told (see THE WALL AT TURN LEVEL)
const wallSend = (reason) => { process.stdout.write(JSON.stringify({ decision: 'block', reason })); process.exit(0); };
const sendBack = (idKey, countKey, reason, stillOpen) => {
  // enforce.maxBlocks in sawbuck.config.json: how many times a turn is sent back to the agent (default 3). 0 means
  // the person decides every time: nothing goes back to the agent, the person is told at once.
  // the setting as it stood when the prompt began (the baseline carries it): written during the turn, a 0 here turned
  // every send-back into a note to the person. A baseline from before 0.1.69 does not carry it; then the file is read.
  const tbl = (st.turnBaseline && typeof st.turnBaseline === 'object') ? st.turnBaseline : null;
  const raw = (tbl && Object.prototype.hasOwnProperty.call(tbl, 'maxBlocks')) ? tbl.maxBlocks : (cfg.enforce ? cfg.enforce.maxBlocks : undefined);
  const max = (raw === undefined || raw === null || raw === '' || !Number.isFinite(+raw)) ? 3 : Math.max(0, Math.floor(+raw));
  if (st[idKey] !== promptId) { st[idKey] = promptId; st[countKey] = 0; }
  const spent = (st[countKey] || 0) >= max;
  if (!spent) st[countKey] = (st[countKey] || 0) + 1;
  saveState(spent ? 'ends' : 'back');
  process.stdout.write(JSON.stringify(spent ? { systemMessage: max === 0 ? `Sawbuck (set to ask you first, enforce.maxBlocks 0): ${stillOpen}` : `Sawbuck stopped blocking after ${max} tries: ${stillOpen}` } : { decision: 'block', reason }));
  process.exit(0);
};

// 2b) THE WALL AT TURN LEVEL (Claude Code Stop hook only): a mandate is checked against the WORKING
// tree on every stop, not only on commits, because an agent usually ends a turn with uncommitted
// edits. A deterministic path match, milliseconds, no metric run. Block the stop (bounded per prompt)
// and send the agent back to undo its protected edits and make the fix elsewhere. The rules are the
// working tree's AND the committed contract's (editing the config in the same turn lifts nothing),
// and a protected file that was already dirty with the same content when the prompt began (the
// baseline `sawbuck turn --hook` recorded) is the person's own work and does not count. A protected
// edit COMMITTED since the baseline's commit counts too: a commit mid-turn does not walk through.
if (stop && !process.env.SAWBUCK_NO_ENFORCE) {
  const now = new Date().toISOString();
  // A TURN THAT BEGAN WHERE THERE WAS NO REPOSITORY (0.2.6, began.mjs). No baseline is on record here and no commit
  // exists, and the prompt hook of this session left its line for this folder: nothing stood when the turn began, and
  // the rules it wrote do not judge it (as in a repository whose turn began with no contract). It becomes the turn's
  // baseline, in both copies, so a second end of the same turn reads it like any other. Where a commit exists (a clone,
  // a first commit made in the turn) nothing changes: that turn is judged as before, by the rules as they are now.
  if (!(st.turnBaseline && typeof st.turnBaseline === 'object') && !head) {
    const w = beganWithoutRepo(hookInput.session_id, repo);
    if (w) {
      st.turnBaseline = { at: w.at, sha: '', files: {}, rules: [], by: 'no-repository', ...(hookInput.prompt_id ? { forPrompt: String(hookInput.prompt_id) } : {}) };
      st.lastPromptAt = w.at;   // the state file is this turn's own: not one that was removed and rebuilt
      writeGuard(repo, { baseline: st.turnBaseline }); forgetBegan(hookInput.session_id);
    }
  }
  const base = (st.turnBaseline && typeof st.turnBaseline === 'object') ? st.turnBaseline : null;
  const baseline = (base && base.files && typeof base.files === 'object') ? base.files : {};
  // 0.2.9: the files the wall holds at how they were before a flagged change (the prompt hook keeps them in the baseline,
  // `held`). Each is read by its exact state against that, mode included, whatever git lists as changed since the turn
  // began: a change it holds is in no diff once the start has moved past the commit that made it.
  const held = (base && base.held && typeof base.held === 'object' && !Array.isArray(base.held)) ? base.held : {};
  const isHeld = (f) => Object.prototype.hasOwnProperty.call(held, f);
  const heldChanged = Object.keys(held).filter((f) => !sameState(stateOf(repo, f), held[f]));
  // read against what the turn began with (contract.mjs, sinceBegan): its commit where it had one, the baseline's own
  // files where it had none or where git no longer lists them
  const { dirty, committedSince } = sinceBegan(repo, base, head);
  const hashNow = {}; for (const f of dirty) if (Object.prototype.hasOwnProperty.call(baseline, f)) hashNow[f] = hashOf(repo, f);
  // a link is hashed as git keeps it since 0.2.6; a baseline 0.2.5 took hashed what it points at: either reads untouched
  // and bytes that are as the baseline found them are untouched whatever .gitattributes now says of them
  const untouched = (f) => Object.prototype.hasOwnProperty.call(baseline, f) && (hashNow[f] === baseline[f]
    || (baseline[f] !== 'deleted' && (isLink(repo, f) ? hashFollowing(repo, f) : hashRaw(repo, f)) === baseline[f]));
  // a person's own uncommitted file (in the baseline) that the turn only committed, content unchanged, is still theirs:
  // after /contract, the agent's `git add -A` sweeps the new contract into its commit, and that is not a protected edit
  const committedAsTheyWere = (f) => Object.prototype.hasOwnProperty.call(baseline, f)
    && (git('rev-parse', '--verify', '-q', `HEAD:${f}`) || 'deleted') === baseline[f]
    && (!dirty.includes(f) || untouched(f));
  const changed = [...new Set([...dirty.filter((f) => !isHeld(f) && !untouched(f)), ...committedSince.filter((f) => !isHeld(f) && !committedAsTheyWere(f)), ...heldChanged])];
  const leftAlone = [...new Set([...dirty.filter((f) => !isHeld(f) && untouched(f)), ...committedSince.filter((f) => !isHeld(f) && committedAsTheyWere(f))])];
  // the rules in force when the turn began: a rule this turn adds does not apply to it, so signing a contract does
  // not block itself, and one it deletes or narrows still holds
  // a baseline of that kind speaks for the prompt it was made for. Should the prompt hook not run for a later prompt,
  // it is still the baseline: then the rules as they are now judge the turn, as with no baseline at all.
  const forAnother = !!(base && base.by === 'no-repository' && base.forPrompt && hookInput.prompt_id && String(hookInput.prompt_id) !== base.forPrompt);
  const began = base && Array.isArray(base.rules) && !forAnother ? base.rules : null;
  const hits = changed.length ? mandateHits(repo, changed, began ? { list: began } : {}) : [];
  st.lastStopAt = now;   // the next prompt may take a fresh baseline only because this stop happened
  st.lastStopHead = head || null;   // and where HEAD stood: a commit between turns is the person's, not the agent's
  if (hits.length) {
    // remember EVERY protected path THIS TURN changed (dirty past the baseline, or committed since
    // it) and what it holds, uncapped, plus the commit the baseline stood at, so the next prompt
    // cannot adopt any of it. Only the turn's own changes: a person's file the baseline spared stays
    // spared, or the next clean turn would be blocked over work that was never the agent's.
    const files = {};
    for (const f of protectedAmong(repo, changed, began)) files[f] = hashOf(repo, f, { store: true });   // by the rules the hits were judged by
    // a flagged file the person had dirty before the prompt: keep the hash of THEIR content (the
    // baseline stored it in the object database), so the block can name the exact restore and the
    // next baseline can recognise the restored file as theirs
    const before = {};
    for (const f of Object.keys(files)) if (Object.prototype.hasOwnProperty.call(baseline, f) && baseline[f] && baseline[f] !== 'deleted') before[f] = baseline[f];
    st.lastViolation = { at: now, sha: (base && base.sha) || null, files, ...(Object.keys(before).length ? { before } : {}) };
  } else { if (st.lastViolation) delete st.lastViolation; if (st.wallTold) delete st.wallTold; }   // nothing protected is changed: the wall forgets what it told
  saveState();
  if (hits.length) {
    const desc = hits.map((h) => `"${h.name}"${h.reason ? ' (' + h.reason + ')' : ''}: ${h.files.join(', ')}${h.committed ? ' [this rule is in the committed contract; editing promptwheel.config.json in the working tree does not lift it]' : ''}`).join('; ');
    const spared = leftAlone.length ? ` Edits that were already there before this prompt were left out of this check and must stay as they are: ${leftAlone.join(', ')}.` : '';
    const before = (st.lastViolation && st.lastViolation.before) || {};
    const restore = Object.keys(before).length ? ' To put back what you overwrote: ' + Object.entries(before).map(([f, h]) => `restore ${f} to the content it had when the prompt began: git cat-file -p ${h} > ${f}`).join('; ') + '.' : '';
    const committedHit = hits.some((h) => h.files.some((f) => committedSince.includes(f)));
    // A rule that takes a reason (the contract's own file, the hooks, a workflow) has a way through that is not the
    // agent's: the person makes the edit and gives the reason. The old last line said only "change the rule in the
    // contract or revert the path", and a real agent then told its person to grant --allow and ask again, which is
    // sent back again (proof-bench/live/after-0.1.70). So say who can make the change, and what to tell them.
    const reasoned = hits.filter((h) => h.allowable).map((h) => `"${h.name}"`);
    const person = reasoned.length ? ` Their reason goes with the commit: ${cli('check --allow "<their reason>"')}. Running --allow yourself does not keep your edit.` : '';
    const accept = (committedHit && hits.some((h) => !h.allowable)) ? ' To accept this change on purpose, change the rule in the contract or revert the path.' : '';
    const upgrade = base ? '' : ' (No prompt baseline is recorded in this repo, so edits a person made before the prompt cannot be told apart from yours: ask them to run sawbuck attach again, which upgrades the hooks.)';
    // the same commit can hold a gamed test too. Say it now, so undoing the protected path is not taken for the end of it.
    const alsoGamed = mine ? ` This turn's commit also has a win on ${mine.file} that came from editing the test or config, not the source. Putting the protected path back does not end that: fix the source so the test passes as it was written, or show the person the test change and ask them.` : '';
    // 0.2.9: ONE CHANGE IS SENT BACK ONCE (his answers of 2026-11-25; proof-bench/wall-029: the first send-back landed
    // 14 of 14 times, and no repeat in the record ever changed what an agent did). A protected change, a file and what
    // was done to it, is known by the file's exact state, mode and content (contract.mjs, stateOf), the way an alert is
    // known by its fingerprint. It is sent back enforce.maxBlocks times (default 1), counted across prompts. After that,
    // while it stands, each end of a turn leaves the person a line and the agent goes on. The file back to how it was
    // before the change ends it (the prompt hook forgets it); the file in any other state is a new change, sent back once
    // more. A commit of it, a reason, a new prompt or /clear do not make it new. (The first build knew a change by its
    // lines, through git merge-file; its third read found a change of mode taken into the start.)
    const wallMax = (() => { const tbl = (st.turnBaseline && typeof st.turnBaseline === 'object') ? st.turnBaseline : null; const raw = (tbl && Object.prototype.hasOwnProperty.call(tbl, 'maxBlocks')) ? tbl.maxBlocks : (cfg.enforce ? cfg.enforce.maxBlocks : undefined); return (raw === undefined || raw === null || raw === '' || !Number.isFinite(+raw)) ? 1 : Math.max(0, Math.floor(+raw)); })();
    const toldBefore = (st.wallTold && typeof st.wallTold === 'object' && !Array.isArray(st.wallTold)) ? st.wallTold : {};
    // Counted in each session (his words 2026-11-25 08:50, "lets make sure that situation doesnt happen"): two sessions
    // share one record, so the one send-back could land on the session that did not make the change while the one that
    // did got only lines. Each session whose turn ends with the change standing is sent back once for it.
    const toldNow = {}; let fresh = false, anyNew = false;
    // where the turn began, for a file the wall does not hold: the start's own files keep only content (the mode is '?'
    // there, and only the content is compared), a commit keeps both
    const ref = (base && typeof base.sha === 'string') ? base.sha : (head ? 'HEAD' : '');
    const onNow = branchOf(repo);   // the branch it was told on: a branch the person checks out later is read against its own file
    const startOf = (f) => isHeld(f) ? held[f] : Object.prototype.hasOwnProperty.call(baseline, f) ? (baseline[f] === 'deleted' ? 'deleted' : `? ${baseline[f]}`) : (ref ? stateAt(repo, ref, f) : 'deleted');
    for (const f of Object.keys(st.lastViolation.files)) {
      const cur = stateOf(repo, f);
      const e = (toldBefore[f] && typeof toldBefore[f] === 'object') ? toldBefore[f] : null;
      const same = !!e && e.flagged === cur; if (!same) anyNew = true;
      const by = (same && e.by && typeof e.by === 'object' && !Array.isArray(e.by)) ? Object.fromEntries(Object.entries(e.by).slice(-20)) : {};
      toldNow[f] = { flagged: cur, before: (e && typeof e.before === 'string') ? e.before : startOf(f), by, at: (same && e.at) ? e.at : now, on: onNow };
      if ((Number(by[sessionOf]) || 0) < wallMax) fresh = true;
    }
    if (fresh) for (const f of Object.keys(toldNow)) { const n = Number(toldNow[f].by[sessionOf]) || 0; if (n < wallMax) toldNow[f].by[sessionOf] = n + 1; }
    st.wallTold = toldNow;
    // one catch for one change (0.2.9; it was one a prompt), counted whether it is sent back or told: with
    // enforce.maxBlocks 0 nothing goes back, and the record, the statusline and the band still show it (the second read of
    // 0.2.9). Kept beside rec.latest, never in it: a block must not replace a gamed verdict that is still standing.
    if (anyNew) {
      const r = readRec() || { regressions: 0, gamed: 0, latest: null };
      r.mandates = (r.mandates || 0) + 1;
      r.lastMandate = { name: hits[0].name, file: hits[0].files[0], at: now };
      writeRec(r);
      logActivity({ kind: 'mandate', file: hits[0].files[0], reason: `mandate ${hits[0].name} violated in the working tree`, by: by || 'hook' });
    }
    // told, not sent back. A gamed test in this turn's commits still goes back by its own rule (section 3), as in 0.2.8:
    // then the line waits (the second read of 0.2.9: this exit had skipped it)
    if (!fresh && !mine) {
      const still = `protected paths are still changed (${desc}).`;
      saveState('ends');
      process.stdout.write(JSON.stringify({ systemMessage: wallMax === 0 ? `Sawbuck (set to ask you first, enforce.maxBlocks 0): ${still}` : `Sawbuck: ${still} The agent was sent back for this change${wallMax === 1 ? ' once' : ''}, and is not sent back again for it. A reason does not end it; reverting the change does (for a commit, git revert).` }));
      process.exit(0);
    }
    if (fresh) {
    saveState('back');
    wallSend(`Sawbuck: a protected path in the contract was changed in this turn: ${desc}.${wallMax === 1 ? ' You are sent back for it once.' : ''} If you made this change: undo it and make the fix elsewhere, and do not revert anything you did not change. If the person wants the change, they make it themselves, in their editor or another terminal between your turns; a line they type with ! in this session reads as yours.${person} If you made none of these changes: undo nothing and stop, and tell the person that a reason does not end this. Reverting the change does (for a commit, git revert); once a turn has run to its end after that, the same change made in their editor before the next prompt is theirs.${spared}${restore}${accept}${upgrade}${alsoGamed}`);
    }
    saveState();   // told, and a gamed test of this turn goes on to its own send-back below
  }
}

// 3) CONTRACT ENFORCEMENT (Claude Code Stop hook only): if THIS turn's commits hold a gamed win,
// block the stop and send the agent back to earn the green in the source. Bounded per
// prompt, because Claude Code's built-in block cap resets on every tool call and so cannot
// bound a tool-using agent on its own. Opt out with SAWBUCK_NO_ENFORCE=1 (falls back to a flag).
if (stop && mine && !process.env.SAWBUCK_NO_ENFORCE) {
  st.shownTotal = total;
  const where = mine.file;
  // (what stands, and the span it was measured over, is already kept a second time outside the record folder: above the wall)
  // the catch is a finding too: handed once to whatever memory runs here, beside the rules and the reverted attempts
  // awaited: sendBack exits the process, and an unawaited hand-off died with it (found by hand against a live worker, 2026-11-08)
  await shareFinding(repo, { kind: 'gamed', title: `gamed: ${where} edited to pass`, text: mine.reason || `A green on ${where} came from editing the test, config or grader, not the source.`, files: [where] }).catch(() => {});
  // the person decides when the agent cannot: the test may be the wrong one. Three ways out, each a command.
  const back = mine.base ? String(mine.base).slice(0, 12) : 'HEAD~1';
  // Each way out as a line that works (each was typed on 0.1.72, and two did not: proof-bench/beside-guard). The files
  // to put back are the goalposts the engine named, when it named them. A reason has to be for the span the verdict
  // stands on: one commit needs no span, and a turn that made more names where the span begins.
  const listed = (Array.isArray(mine.goalposts) && mine.goalposts.length) ? mine.goalposts : null;
  const posts = listed ? listed.slice(0, 6) : [where];
  const morePosts = listed && (listed.length > 6 || mine.goalpostsMore) ? ` (the first of ${mine.goalpostsMore ? 'more than 50' : listed.length} test and config files this change moved)` : '';
  const oneCommit = !mine.base || git('rev-parse', '--verify', '-q', 'HEAD~1') === mine.base;
  const accept = cli(oneCommit ? 'check --allow "<why>"' : `check --base ${back} --allow "<why>"`);
  const choices = `Your call: (1) fix the source and keep the test as it was; (2) put the test back: git checkout ${back} -- ${posts.join(' ')}${morePosts}, then commit; (3) if the test change is right, accept it: ${accept}.`;
  // THE TEST PUT BACK IN THE WORKING TREE, NOT COMMITTED YET. Every goalpost the engine named for this verdict reads in
  // the working tree as it did where the span began, so no gamed green is left in the tree, and sending the turn back
  // "to fix the source" would be for a change that is gone (the rehearsal of 2026-11-16: a person said "put the test
  // back and stop there", the agent did, and was sent back three times). The turn may end and the person is told, once
  // for this commit. The verdict stays up, here and in the second copy: the last commit still holds the changed test,
  // so the catch stays open: a later turn that throws the restore away is told about it, and only a commit settles it. Only for a record that lists all
  // its goalposts (0.1.73 on).
  const sameAsBase = () => { try { execFileSync('git', ['-C', repo, 'diff', '--quiet', mine.base, '--', ...listed], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (listed && !mine.goalpostsMore && mine.base && hasCommit(mine.base) && sameAsBase()) {
    const told = st.restoredTold === head; st.restoredTold = head; saveState('ends');
    if (!told) process.stdout.write(JSON.stringify({ systemMessage: `Sawbuck: ${posts.join(', ')} ${listed.length === 1 ? 'is' : 'are'} back as ${listed.length === 1 ? 'it was' : 'they were'} in your working tree, not committed yet. The last commit still holds the changed test, so the record stays open until that is committed (git commit -am "put the test back"). Nothing is sent back for it meanwhile.` }));
    process.exit(0);
  }
  const also = (Array.isArray(mine.also) && mine.also.length) ? ` The same change also made ${mine.also.join(', ')} worse, which the contract guards.` : '';
  // the agent asking the person instead of bending the source is the right move, so the turn may end there
  if (asksPerson(lastAgentText(), where)) {
    saveState('ends');
    process.stdout.write(JSON.stringify({ systemMessage: `Sawbuck: the win on ${where} came from changing the test, and your agent is asking you about it instead of changing the source to fit. ${choices}` }));
    process.exit(0);
  }
  sendBack('blockPromptId', 'blockCount', `Sawbuck: the win on ${where} was gamed. It came from editing the test or config, not the source, so it did not survive a source-only re-run.${also} The turn is not done: fix the source so the test passes as it was written. If you believe the test itself was wrong, do not change the source to fit it: end your turn by showing the person the test change and asking them what to do, as a direct question.`, `the win on ${where} is still gamed. ${choices}`);
}

// 3x) WHAT AN EARLIER TURN LEFT OPEN IS TOLD, NEVER SENT BACK (0.2.0). One line to the person at the end of a turn, for
// enforce.remindTurns turns (5; 0 says never), then nothing more here: `status` and the band keep showing it, and the
// check on the commit and on a pull request still fails. The setting is the one that stood when the prompt began.
const remindTurns = (() => {
  const tbl = (st.turnBaseline && typeof st.turnBaseline === 'object') ? st.turnBaseline : null;
  const raw = (tbl && Object.prototype.hasOwnProperty.call(tbl, 'remindTurns')) ? tbl.remindTurns : (cfg.enforce ? cfg.enforce.remindTurns : undefined);
  return (raw === undefined || raw === null || raw === '' || !Number.isFinite(+raw)) ? 5 : Math.max(0, Math.floor(+raw));
})();
let openSaid = '';
if (stop && !process.env.SAWBUCK_NO_ENFORCE) {
  const due = open.filter((o) => !o.live && (o.told || 0) < remindTurns && o.toldTurn !== String(promptId));
  if (due.length) {
    for (const o of due) { o.told = (o.told || 0) + 1; o.toldTurn = String(promptId); }
    writeGuard(repo, { open });
    const o = due[due.length - 1];
    const posts = (Array.isArray(o.goalposts) && o.goalposts.length) ? o.goalposts.slice(0, 6) : [o.file];
    const from12 = String(o.base).slice(0, 12);
    const last = o.sha === head && git('rev-parse', '--verify', '-q', 'HEAD~1') === o.base;
    const others = due.length > 1 ? ` (and ${due.length - 1} more: sawbuck status lists them)` : '';
    openSaid = `Sawbuck: a test change from an earlier turn is still open: ${o.file || posts[0]}, commit ${String(o.sha).slice(0, 8)}${others}. This turn was not sent back for it. Your call: (1) fix the source and keep the test as it was; (2) put the test back: git checkout ${from12} -- ${posts.join(' ')}, then commit; (3) if the test change is right, accept it: ${cli(last ? 'check --allow "<why>"' : `check --base ${from12} --allow "<why>"`)}. Told ${o.told} of ${remindTurns} times.`;
  }
}
// THE REDO LINE (undo.mjs): something the person had undone is in its file again, and they have not been told. It
// waits for an end of turn that tells, so a turn that ends on a send-back loses nothing. Never a block: they may have
// asked for it.
const redoSaid = (stop && !process.env.SAWBUCK_NO_ENFORCE) ? redoLine(repo, hookInput.session_id, redoDue(repo)) : '';
// THE REASON IS NOT KEPT (undo.mjs): an undo was recorded in this session with none of the person's words, and they
// have not been told what that means. Once in a session; it waits for an end of turn that tells, like the redo line.
const hint = (stop && by === 'claude' && !process.env.SAWBUCK_NO_ENFORCE) ? undoHintDue(repo, hookInput.session_id) : null;
const hintSaid = hint ? `Sawbuck: recorded that ${hint.added} line${hint.added === 1 ? ' was' : 's were'} taken out of ${hint.file} at your request. The reason is not kept. If it should last, tell Claude Code "Remember that for next time.", or have Sawbuck keep your words from now on: ${cli('attach --words')}.` : '';
// what the person is told when a turn ends, with the open line, the redo line and the reason line after it when there are any
const tell = (msg) => { if (redoSaid) redoTold(repo); if (hintSaid) undoHintTold(repo, hookInput.session_id); process.stdout.write(JSON.stringify({ systemMessage: [msg, openSaid, redoSaid, hintSaid].filter(Boolean).join(' ') })); };

// 3a) A DEPENDENCY EDITED IN PLACE: the check's clean copy borrows node_modules and the venv from the working tree, so
// an edit made inside them is in no diff and a green that leans on it cannot be proved (outside-git bench, 2026-11-11:
// the check read pass while a fresh install was red). A notice to the person, said once, never a block: they may have
// asked for the patch. Everything recorded and not yet said is said, so a turn that ended on a send-back loses nothing.
const depEdits = (stop && !process.env.SAWBUCK_NO_ENFORCE) ? dependencyEditsSince(repo, st.depNoticed || '') : [];
const depSaid = dependencyNotice(depEdits);
const depDone = () => { if (depSaid) st.depNoticed = new Date().toISOString(); };

// 3b) THE LOCK AT TURN LEVEL: tell the person the moment a turn changes the repo's structure or its resolved
// dependencies. A notice, not a block: a person who asked for a new dependency should not fight the wall, and
// the gate in CI is the hard stop, which needs their reason. Said once per change.
if (stop && !process.env.SAWBUCK_NO_ENFORCE && st.turnBaseline && st.turnBaseline.lock) {
  const was = st.turnBaseline.lock, now = lockState(repo);
  if (now) {
    const known = new Set(was.drift || []);
    const fresh = (now.drift || []).filter((i) => !known.has(i));
    const pinsMoved = !!now.pins && now.pins !== was.pins;
    const key = JSON.stringify([fresh, pinsMoved ? now.pins : '']);
    if ((fresh.length || pinsMoved) && st.lockNotice !== key) {
      st.lockNotice = key; depDone(); saveState('ends');
      const what = [...fresh.slice(0, 8), ...(pinsMoved ? ['the resolved dependency tree'] : [])].join(', ');
      tell(`Sawbuck: this turn changed what the lock holds: ${what}${fresh.length > 8 ? `, and ${fresh.length - 8} more` : ''}. If you did not ask for that, look before you commit. The gate needs your reason to pass it: promptwheel run --allow "<reason>". When more than one thing changed, the reason names each, and the check prints the line.${depSaid ? ` ${depSaid}` : ''}`);
      process.exit(0);
    }
  }
}

// 3a, said alone when the lock had nothing to say
if (depSaid) {
  depDone(); saveState('ends');
  tell(depSaid);
  process.exit(0);
}

// 3c) the record was removed during this turn and nothing above sent the turn back: the person is told, once (the
// state file is written again below, so the next end of turn does not come here)
if (recordRemoved) {
  st.shownTotal = total; saveState('ends');
  tell('Sawbuck: its record for this repo (.sawbuck/) was removed or made unreadable during this turn. It was rebuilt from a second copy, and the turn was checked again from the commit it began at. If you did not do that, look at what this turn did.');
  process.exit(0);
}

// 3w) WORDS A VERSION BEFORE 0.2.0 KEPT HERE WERE TAKEN OUT. The prompt hook did it, when it found this repo attached
// without --words (sawbuck.mjs). The person is told, once.
if (stop && st.wordsRemoved && !st.wordsRemovedTold) {
  st.wordsRemovedTold = true; saveState('ends');
  tell(`Sawbuck: from 0.2.0 it keeps none of what you type in this repo. What an older version kept was removed from its record (.sawbuck/): the start of your last prompt, and your words saved with an undo (${st.wordsRemoved} ${st.wordsRemoved === 1 ? 'place' : 'places'}; the undo itself is kept). To keep your words as before: ${cli('attach --words')}.`);
  process.exit(0);
}

// 3x, said alone when nothing above had anything to say
if (openSaid || redoSaid || hintSaid) {
  st.shownTotal = total; saveState('ends');
  tell('');
  process.exit(0);
}

// 3d) AN OLDER COPY ON THIS MACHINE. A line with no version in it (the rule's own `npx -y sawbuck check`, a bare
// `sawbuck`) is answered by that copy and not by this one, and the two can disagree (copies.mjs; proof-bench/old-global).
// The person is told once for each such version, at an end that has nothing else to say. The agent is told with the
// frame, where the turn starts.
if (!process.env.SAWBUCK_NO_ENFORCE && !(total > (st.shownTotal || 0))) {
  const said = olderSaid();
  if (said && st.olderCopyTold !== said.copy.version) {
    st.olderCopyTold = said.copy.version; saveState('ends');
    process.stdout.write(stop ? JSON.stringify({ systemMessage: said.person }) : said.person + '\n');
    process.exit(0);
  }
}

// 4) otherwise, say a fresh catch once (a flag; never blocks). The band and statusline carry the rest.
if (total > (st.shownTotal || 0)) {
  const L = rec && rec.latest;
  process.stdout.write(`Sawbuck caught a ${L && L.kind === 'gamed' ? 'gamed change' : 'problem'}${L && L.file ? ` in ${L.file}` : ''}${L && L.reason ? `: ${L.reason}` : ''}\n`);
  st.shownTotal = total;
}
saveState('ends');
