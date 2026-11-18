// The undo ledger: what the agent tried and the person had undone, inside a session, with nothing left in git.
// The attempts bench (2026-11-10) measured it: an approach undone at the person's request, never committed, came back
// in the next session 27 of 27 times; with the record shown at the prompt, 0 of 27. So the ledger that keeps erased
// reverts also keeps undone attempts.
// AN UNDO IS WHAT WAS THERE WHEN THE PERSON SPOKE AND IS GONE WHEN THAT TURN ENDS (0.2.0). Three moments:
//   before an edit    the file is snapshotted, once per session (`attach` wires the edit tools for this): what it held
//                     before the agent first touched it;
//   at each prompt    undoMark: a file that is not as the last commit holds it, and has no snapshot yet, gets one from
//                     git (a shell command wrote it, or an earlier session did); then, for each file with a
//                     snapshot, what has been added to it as it stands now;
//   at the turn's end undoJudge: the file now against that picture. Back at its snapshot, or as it stood at an earlier
//                     prompt of this session: a whole undo. Most of what was there gone, and little new in its place:
//                     a partial one. Anything else is not an undo.
// Until 0.2.0 an undo was judged after each edit, by the edit hooks alone, and a real session showed three faults in
// one go (proof-bench/undo-by-git, 2026-11-17): an undo the agent made with `git checkout` ran no edit hook and was
// not recorded; the agent's second try was then read against a state that was no longer in the file, and recorded as a
// partial undo with that request as the person's words; and the real partial undo after it was not recorded. Judged
// at the end of the turn, from the file itself, it does not matter which tool took the lines out, and lines replaced
// by a rewrite are not lines taken out.
// The same day a bench showed it mattered which tool PUT the lines IN (proof-bench/undo-words): in two of three first
// sessions the agent wrote its change with `cat > file`, no edit hook ran, and the undo left no record. So the base
// comes from git where no edit hook gave one. A turn that stashes or changes branch is not judged: the lines were set
// aside, not taken out.
// THE REDO LINE (0.2.0). An undo is kept with a mark for each line that was taken out (a hash; the first line was
// always kept as text, nothing more is). When a later turn leaves at least three quarters of those lines, and two or
// more, in the file again, redoJudge records it and the end of the turn tells the person. Told, never sent back: they may have
// asked. Lines that are back when the person speaks were put back between turns, by them: noted for that turn, and not
// told. The record (.sawbuck/redone.jsonl) holds only what the person was told; whether an undone change is "in the
// file again" is read from the file each time, so it stops being said when the lines go again or the branch changes.
// Deterministic. No model. Stores a diff summary, and the person's own prompt only where the repo is attached with --words.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { localDay } from './day.mjs';
import { realPath } from './repo-state.mjs';
import { gitNames } from './contract.mjs';

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const EDIT_MATCHER = EDIT_TOOLS.join('|');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const undonePath = (repo) => join(repo, '.sawbuck', 'undone.jsonl');

export function readUndone(repo) {
  try { return readFileSync(undonePath(repo), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.file); } catch { return []; }
}

// As typed first. A path that reads as outside the repo is tried again by real paths: a tool may name a file through a
// symlink to the repo's folder (on a Mac /tmp is one), and it is the same file.
const relFile = (repo, p) => {
  if (!p) return ''; const abs = isAbsolute(p) ? p : join(repo, p);
  let r = relative(repo, abs); if (!r || r.startsWith('..')) r = relative(realPath(repo), realPath(abs));
  return !r || r.startsWith('..') ? '' : r;
};
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

// what a change added, for the record: the count of new lines and the first one (a set difference of lines)
export function addedSummary(before, after) {
  const had = new Set(String(before || '').split('\n'));
  const added = String(after || '').split('\n').filter((l) => l.trim() && !had.has(l));
  return { added: added.length, first: (added[0] || '').trim().slice(0, 80) };
}

// the lines a text holds that its snapshot did not
const addedLines = (base, text) => { const had = new Set(String(base || '').split('\n')); return String(text || '').split('\n').filter((l) => l.trim() && !had.has(l)); };
const sessOf = (session) => (String(session || '').replace(/[^\w-]/g, '').slice(0, 40)) || 's';
const snapsOf = (repo, sess) => {
  const dir = join(repo, '.sawbuck', 'snap', sess); let names = []; try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch {}
  return names.map((n) => { try { const rec = JSON.parse(readFileSync(join(dir, n), 'utf8')); return rec && rec.file ? { p: join(dir, n), rec } : null; } catch { return null; } }).filter(Boolean);
};
const picture = (rec, t, at) => ({ hash: t === null ? '' : sha(t), lines: addedLines(rec.baseText, t).slice(0, 200), at });
const gitText = (repo, ...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }); } catch { return null; } };

// WHEN THE PERSON SPOKE: one small file for the session's open turn. Where git stood (a turn that stashes or changes
// branch set the lines aside and is not judged), and whether an end of turn has looked at it yet.
const turnPath = (repo, sess) => join(repo, '.sawbuck', 'snap', sess, 'turn.json');
const readTurn = (repo, sess) => { try { const t = JSON.parse(readFileSync(turnPath(repo, sess), 'utf8')); return t && typeof t === 'object' && t.at ? t : null; } catch { return null; } };
const whereGit = (repo) => ({ stash: (gitText(repo, 'rev-parse', '-q', '--verify', 'refs/stash') || '').trim(), branch: (gitText(repo, 'symbolic-ref', '-q', 'HEAD') || '').trim() });
const setAside = (repo, turn) => { if (!turn) return false; const now = whereGit(repo); return now.stash !== (turn.stash || '') || now.branch !== (turn.branch || ''); };

// A BASE FROM GIT. A file that is not as the last commit holds it when the person speaks, and that no edit hook gave a
// snapshot in this session (a shell command wrote it, or an earlier session left it uncommitted), gets its base from
// that commit. A file git does not track gets "it was not there", and only when it was written since the person last
// spoke in this session. The newest twenty at a prompt, two hundred in a session, and no file over 256 KB or binary.
const BASES = 20, BASES_ALL = 200, BIG = 256 * 1024;
function basesFromGit(repo, sess, since, now) {
  let changed = [], loose = [];
  try { changed = gitNames(repo, ['diff', '--name-only', '--no-renames', 'HEAD']); loose = gitNames(repo, ['ls-files', '--others', '--exclude-standard']); } catch { return; }
  const dir = join(repo, '.sawbuck', 'snap', sess); let have = 0; try { have = readdirSync(dir).length; } catch {}
  const from = since ? Date.parse(since) - 2000 : NaN; const fresh = [];
  for (const [file, tracked] of [...changed.map((f) => [f, true]), ...loose.map((f) => [f, false])]) {
    if (!file || file.startsWith('.sawbuck')) continue;
    const p = join(dir, `${sha(file)}.json`); if (existsSync(p)) continue;
    let st = null; try { st = statSync(join(repo, file)); } catch {}
    if (st && (!st.isFile() || st.size > BIG)) continue;
    if (!tracked && !(st && Number.isFinite(from) && st.mtimeMs >= from)) continue;
    fresh.push({ file, p, tracked, m: st ? st.mtimeMs : 0 });
  }
  fresh.sort((a, b) => b.m - a.m);
  for (const { file, p, tracked } of fresh.slice(0, Math.max(0, Math.min(BASES, BASES_ALL - have)))) {
    const base = tracked ? gitText(repo, 'show', `HEAD:${file}`) : null;   // null: the last commit does not hold it
    const t = readText(join(repo, file));
    if ((base !== null && (base.length > BIG || base.includes('\0'))) || (t !== null && t.includes('\0'))) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ file, baseText: base, baseHash: base === null ? '' : sha(base), at: now, from: 'git', atPrompt: { hash: base === null ? '' : sha(base), lines: [], at: '' } }));
  }
}

// before an edit to `file`: snapshot it once per session. (After an edit there is nothing to do any more: an undo is
// judged when the turn ends.) Never throws.
export function undoObserve(repo, { session = 's', file, event, before = undefined }) {
  try {
    if (!file || file.startsWith('.sawbuck')) return null;
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return null;   // never writes in a repo sawbuck is not attached to
    if (event !== 'pre') return null;
    const sess = sessOf(session);
    const dir = join(repo, '.sawbuck', 'snap', sess); const p = join(dir, `${sha(file)}.json`);
    if (existsSync(p)) return null;
    mkdirSync(dir, { recursive: true }); const t = before !== undefined ? before : readText(join(repo, file));
    // a file the agent first touches inside a turn held nothing of the agent's when the person spoke
    writeFileSync(p, JSON.stringify({ file, baseText: t, baseHash: t === null ? '' : sha(t), at: new Date().toISOString(), atPrompt: { hash: t === null ? '' : sha(t), lines: [], at: '' } }));
    return null;
  } catch { return null; }
}

// A session's copies are working data: they are removed two weeks after that session's last prompt. Looked at once, at
// a session's first prompt. (A session picked up again after that gets its bases from git.)
const KEEP_DAYS = 14;
function pruneSnaps(repo, sess) {
  const root = join(repo, '.sawbuck', 'snap'); let names = []; try { names = readdirSync(root); } catch { return; }
  const old = Date.now() - KEEP_DAYS * 86400000;
  for (const n of names) {
    if (n === sess) continue;
    try { let m = statSync(join(root, n)).mtimeMs; try { m = Math.max(m, statSync(join(root, n, 'turn.json')).mtimeMs); } catch {} if (m < old) rmSync(join(root, n), { recursive: true, force: true }); } catch {}
  }
}

// when the person speaks: a base from git for what no edit hook saw; then, for each file with a snapshot, what has been
// added to it as it stands now (and how it stood at the prompts before, so a file put back as it was two prompts ago
// is known); then where git stands; and what of the undone is back in its file already, which is the person's doing.
export function undoMark(repo, session) {
  try {
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return;   // never writes in a repo sawbuck is not attached to
    const sess = sessOf(session); const now = new Date().toISOString(); const last = readTurn(repo, sess);
    if (!last) pruneSnaps(repo, sess);
    basesFromGit(repo, sess, last && last.at, now);
    for (const { p, rec } of snapsOf(repo, sess)) {
      if (rec.atPrompt && typeof rec.atPrompt.hash === 'string') rec.seen = [...new Set([...(Array.isArray(rec.seen) ? rec.seen : []), rec.atPrompt.hash])].slice(-12);
      rec.atPrompt = picture(rec, readText(join(repo, rec.file)), now); delete rec.recordedFor; writeFileSync(p, JSON.stringify(rec));
    }
    mkdirSync(join(repo, '.sawbuck', 'snap', sess), { recursive: true });
    writeFileSync(turnPath(repo, sess), JSON.stringify({ at: now, ...whereGit(repo), back: backNow(repo).map((b) => b.id) }));
  } catch { /* the ledger never fails a prompt */ }
}

// when the turn ends: what was there when the person spoke and is gone now, whatever took it out. One record for a
// file and a prompt at most. `why` is the person's prompt, where the repo keeps such words. Returns the new entries.
export function undoJudge(repo, session, why = '') {
  const out = [];
  try {
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return out;
    const sess = sessOf(session); const now = new Date().toISOString();
    if (setAside(repo, readTurn(repo, sess))) return out;   // stashed, or another branch: set aside, not taken out
    for (const { p, rec } of snapsOf(repo, sess)) {
      const was = rec.atPrompt && Array.isArray(rec.atPrompt.lines) ? rec.atPrompt.lines : [];
      if (!was.length || rec.recordedFor === rec.atPrompt.at) continue;   // nothing of the agent's was there when the person spoke, or this turn's undo is already recorded
      const t = readText(join(repo, rec.file)); const hash = t === null ? '' : sha(t);
      if (hash === rec.atPrompt.hash) continue;   // as it was when the person spoke
      const has = new Set(String(t || '').split('\n')); const gone = was.filter((l) => !has.has(l));
      let kind = '';
      if (hash === rec.baseHash || (Array.isArray(rec.seen) && rec.seen.includes(hash))) kind = 'whole';   // back as it was before the first change, or as it stood at an earlier prompt
      else {
        // most of what was there is gone (at least half its lines, and two or more), and little new stands in its
        // place: lines replaced by other lines are a rewrite, not an undo
        const seen = new Set(was); const fresh = addedLines(rec.baseText, t).filter((l) => !seen.has(l));
        if (gone.length >= 2 && gone.length * 2 >= was.length && fresh.length * 2 <= gone.length) kind = 'part';
      }
      if (!kind || !gone.length) continue;
      // a mark for each line taken out that the file does not hold anywhere now: what the redo line compares
      const left = new Set(String(t || '').split('\n').map((l) => l.trim()));
      const lines = [...new Set(gone.map((l) => l.trim()).filter((l) => l && !left.has(l)).map(markOf))].slice(0, 200);
      const entry = { at: now, file: rec.file, kind, added: gone.length, first: gone[0].trim().slice(0, 80), why: String(why || '').replace(/\s+/g, ' ').trim().slice(0, 240), session: sess, lines };
      appendFileSync(undonePath(repo), JSON.stringify(entry) + '\n'); out.push(entry);
      rec.recordedFor = rec.atPrompt.at; writeFileSync(p, JSON.stringify(rec));
    }
  } catch { /* the ledger never fails a turn */ }
  return out;
}

// THE REDO LINE. What was undone and is in its file again.
const markOf = (trimmed) => createHash('sha256').update(trimmed).digest('hex').slice(0, 10);
const idOf = (e) => `${e.at} ${e.file}`;
export const redonePath = (repo) => join(repo, '.sawbuck', 'redone.jsonl');
const saidPath = (repo) => join(repo, '.sawbuck', 'redone.said');
export function readRedone(repo) {
  try { return readFileSync(redonePath(repo), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.id); } catch { return []; }
}
// the undos, newest fifty, whose lines are in their file as it stands: at least
// three quarters of the marked lines, and two or more. (Half was the first rule. Held against 81 real runs it fired on
// one that had not redone anything: four of seven lines that any code for the job holds, an import and a try/catch.
// proof-bench/undo-words, 2026-11-17.) An undo with fewer than two marks is not watched (one line can come back by
// chance), and one an older version recorded has none.
function backNow(repo) {
  const out = []; const texts = new Map(); const seen = new Set();
  for (const e of readUndone(repo).reverse().slice(0, 50)) {
    if (!Array.isArray(e.lines) || e.lines.length < 2) continue;
    const same = `${e.file}\n${e.lines.join()}`; if (seen.has(same)) continue; seen.add(same);   // the same change undone twice: the newest record speaks
    if (!texts.has(e.file)) { const t = readText(join(repo, e.file)); const firstOf = new Map(); for (const l of String(t || '').split('\n')) { const x = l.trim(); if (x) { const m = markOf(x); if (!firstOf.has(m)) firstOf.set(m, x); } } texts.set(e.file, firstOf); }
    const firstOf = texts.get(e.file); const back = e.lines.filter((m) => firstOf.has(m));
    if (back.length >= 2 && back.length * 4 >= e.lines.length * 3) out.push({ id: idOf(e), e, back: back.length, of: e.lines.length, first: firstOf.get(back[0]).slice(0, 80) });
  }
  return out;
}
// when a turn ends (and at the next prompt, for a turn that never reached its end): what was undone and came back in
// its file since the person spoke. Recorded once. `end` notes that an end of turn has looked at this turn.
export function redoJudge(repo, session, { end = false } = {}) {
  const out = [];
  try {
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return out;
    const sess = sessOf(session); const turn = readTurn(repo, sess); if (!turn) return out;   // no word on when the person spoke: nothing to hold it against
    if (!end && turn.ended) return out;   // an end of turn has looked already: what is back now, the person put back
    const now = new Date().toISOString();
    if (!setAside(repo, turn)) {
      const had = new Set(Array.isArray(turn.back) ? turn.back : []); const told = new Set(readRedone(repo).map((r) => r.id));
      for (const b of backNow(repo)) { if (had.has(b.id) || told.has(b.id)) continue;   // there when the person spoke (their doing), or told already
        const entry = { at: now, id: b.id, file: b.e.file, undoneAt: b.e.at, back: b.back, of: b.of, first: b.first, turnAt: turn.at, session: sess }; appendFileSync(redonePath(repo), JSON.stringify(entry) + '\n'); out.push(entry); }
    }
    if (end && !turn.ended) writeFileSync(turnPath(repo, sess), JSON.stringify({ ...turn, ended: now }));
  } catch { /* the ledger never fails a turn */ }
  return out;
}
// what the person has not been told yet, and the line that tells it. redoTold is called when the line is written out.
export function redoDue(repo) {
  let said = ''; try { said = readFileSync(saidPath(repo), 'utf8').trim(); } catch {}
  return readRedone(repo).filter((r) => String(r.at) > said);
}
export function redoTold(repo) { try { writeFileSync(saidPath(repo), new Date().toISOString() + '\n'); } catch {} }
export function redoLine(repo, session, due) {
  if (!due || !due.length) return '';
  const turn = readTurn(repo, sessOf(session)); const r = due[0]; const mine = turn && r.turnAt === turn.at;
  const one = (x) => `${x.file} holds ${x.back} of the ${x.of} lines again that were taken out at your request on ${localDay(x.undoneAt)}, starting \`${x.first}\``;
  const more = due.slice(1, 3).map((x) => `${x.file} (${x.back} of ${x.of} lines)`); const rest = due.length - 1 - more.length;
  return `Sawbuck: ${mine ? 'this turn' : 'a turn before this one'} put back something you had undone: ${one(r)}.${more.length ? ` Also ${more.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.` : ''} If you asked for that, there is nothing to do. If you did not, tell the agent to undo it.`;
}

// THE REASON IS NOT KEPT. Where none of the person's words are kept, an undo is recorded without its reason, and the
// record alone did not keep a later session from making the change again (undo-words bench). So the person is told,
// once in a session, at the end of a turn that recorded one: the first such undo is noted here, and the note is marked
// when the end-of-turn hook has said it. (Not a .json name: the session's folder holds one .json per file it watches.)
const hintPath = (repo, sess) => join(repo, '.sawbuck', 'snap', sess, 'reason-hint');
export function undoHintNote(repo, session, entry) {
  try { const sess = sessOf(session); const p = hintPath(repo, sess); if (existsSync(p)) return; mkdirSync(join(repo, '.sawbuck', 'snap', sess), { recursive: true }); writeFileSync(p, JSON.stringify({ file: entry.file, added: entry.added, at: entry.at, told: '' })); } catch {}
}
export function undoHintDue(repo, session) { try { const h = JSON.parse(readFileSync(hintPath(repo, sessOf(session)), 'utf8')); return h && !h.told && h.file ? h : null; } catch { return null; } }
export function undoHintTold(repo, session) { try { const p = hintPath(repo, sessOf(session)); const h = JSON.parse(readFileSync(p, 'utf8')); h.told = new Date().toISOString(); writeFileSync(p, JSON.stringify(h)); } catch {} }

// Claude Code's PreToolUse / PostToolUse on the edit tools
export function undoHook(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return null; }
  if (!EDIT_TOOLS.includes(String(h.tool_name || ''))) return null;
  const input = h.tool_input || {};
  const file = relFile(repo, input.file_path || input.notebook_path);
  const event = h.hook_event_name === 'PreToolUse' ? 'pre' : h.hook_event_name === 'PostToolUse' ? 'post' : '';
  return undoObserve(repo, { session: h.session_id, file, event });
}

// Codex: apply_patch carries a patch; the files it names are snapshotted before and observed after
export function patchFiles(command) {
  return [...String(command || '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}
export function undoCodex(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return []; }
  const cmd = (h.tool_input && (h.tool_input.command || h.tool_input.patch || h.tool_input.input)) || '';
  const event = h.hook_event_name === 'PreToolUse' ? 'pre' : h.hook_event_name === 'PostToolUse' ? 'post' : '';
  return patchFiles(cmd).map((f) => undoObserve(repo, { session: h.session_id, file: relFile(repo, f), event })).filter(Boolean);
}

// Cursor: afterFileEdit only, with the edits made; the text before them is the text after, each edit reversed
export function undoCursor(body, repo) {
  let h; try { h = JSON.parse(body || '{}'); } catch { return null; }
  const file = relFile(repo, h.file_path); if (!file) return null;
  const now = readText(join(repo, file)); if (now === null) return null;
  let before = now; for (const e of [...(h.edits || [])].reverse()) { if (e && typeof e.new_string === 'string' && before.includes(e.new_string)) before = before.replace(e.new_string, String(e.old_string || '')); }
  const session = String(h.conversation_id || h.session_id || 'cursor');
  return undoObserve(repo, { session, file, event: 'pre', before });   // the snapshot; the undo itself is judged when the turn ends
}

// the lines the prompt hook and `context` add for the paths in hand: newest first, one per file and change, three at most
export function undoneLines(repo, changed) {
  const touched = new Set(changed || []);
  const seen = new Set(); const out = []; const back = new Set(backNow(repo).map((b) => b.id));
  for (const e of readUndone(repo).reverse()) {
    if (!touched.has(e.file)) continue;
    const k = `${e.file}\n${e.first}`; if (seen.has(k)) continue; seen.add(k);
    const again = back.has(idOf(e));   // read from the file as it stands: say both, so nobody reads the undo as still standing
    // with no reason on record the line was read as a lead and passed over (undo-words bench: 22 of 27 made the change
    // again, 17 of them after saying they had read it). So it says the reason is not there, and what to do: ask.
    const tail = e.why ? `. Your words: "${e.why}"` : (again ? '' : '. The reason is not on record. Before you make a change like this one again, in these lines or in others, stop and ask the person.');
    out.push(`    - ${e.kind === 'part' ? 'partly undone' : 'undone'} here at your request (${localDay(e.at)})${again ? ', and in the file again now' : ''}: ${e.added} line${e.added === 1 ? '' : 's'} starting \`${e.first}\` in ${e.file}${tail}`);
    if (out.length === 3) break;
  }
  return out;
}
