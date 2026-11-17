// The undo ledger: what the agent tried and the person had undone, inside a session, with nothing left in git.
// The attempts bench (2026-11-10) measured it: an approach undone at the person's request, never committed, came back
// in the next session 27 of 27 times; with the record shown at the prompt, 0 of 27. So the ledger that keeps erased
// reverts also keeps undone attempts.
// AN UNDO IS WHAT WAS THERE WHEN THE PERSON SPOKE AND IS GONE WHEN THAT TURN ENDS (0.2.0). Three moments:
//   before an edit    the file is snapshotted, once per session (`attach` wires the edit tools for this): what it held
//                     before the agent first touched it;
//   at each prompt    undoMark: for each file with a snapshot, what the agent has added to it as it stands now;
//   at the turn's end undoJudge: the file now against that picture. Back at its snapshot: a whole undo. Most of what
//                     was there gone, and little new in its place: a partial one. Anything else is not an undo.
// Until 0.2.0 an undo was judged after each edit, by the edit hooks alone, and a real session showed three faults in
// one go (proof-bench/undo-by-git, 2026-11-17): an undo the agent made with `git checkout` ran no edit hook and was
// not recorded; the agent's second try was then read against a state that was no longer in the file, and recorded as a
// partial undo with that request as the person's words; and the real partial undo after it was not recorded. Judged
// at the end of the turn, from the file itself, it does not matter which tool took the lines out, and lines replaced
// by a rewrite are not lines taken out.
// Deterministic. No model. Stores a diff summary, and the person's own prompt only where the repo is attached with --words.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { localDay } from './day.mjs';
import { realPath } from './repo-state.mjs';

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

// when the person speaks: for each file the agent has touched in this session, what it has added as it stands now
export function undoMark(repo, session) {
  try {
    const now = new Date().toISOString();
    for (const { p, rec } of snapsOf(repo, sessOf(session))) { rec.atPrompt = picture(rec, readText(join(repo, rec.file)), now); delete rec.recordedFor; writeFileSync(p, JSON.stringify(rec)); }
  } catch { /* the ledger never fails a prompt */ }
}

// when the turn ends: what was there when the person spoke and is gone now, whatever took it out. One record for a
// file and a prompt at most. `why` is the person's prompt, where the repo keeps such words. Returns the new entries.
export function undoJudge(repo, session, why = '') {
  const out = [];
  try {
    if (!existsSync(join(repo, '.sawbuck', 'state.json'))) return out;
    const sess = sessOf(session); const now = new Date().toISOString();
    for (const { p, rec } of snapsOf(repo, sess)) {
      const was = rec.atPrompt && Array.isArray(rec.atPrompt.lines) ? rec.atPrompt.lines : [];
      if (!was.length || rec.recordedFor === rec.atPrompt.at) continue;   // nothing of the agent's was there when the person spoke, or this turn's undo is already recorded
      const t = readText(join(repo, rec.file)); const hash = t === null ? '' : sha(t);
      if (hash === rec.atPrompt.hash) continue;   // as it was when the person spoke
      const has = new Set(String(t || '').split('\n')); const gone = was.filter((l) => !has.has(l));
      let kind = '';
      if (hash === rec.baseHash) kind = 'whole';   // back as it was before the agent first touched it
      else {
        // most of what was there is gone (at least half its lines, and two or more), and little new stands in its
        // place: lines replaced by other lines are a rewrite, not an undo
        const seen = new Set(was); const fresh = addedLines(rec.baseText, t).filter((l) => !seen.has(l));
        if (gone.length >= 2 && gone.length * 2 >= was.length && fresh.length * 2 <= gone.length) kind = 'part';
      }
      if (!kind || !gone.length) continue;
      const entry = { at: now, file: rec.file, kind, added: gone.length, first: gone[0].trim().slice(0, 80), why: String(why || '').replace(/\s+/g, ' ').trim().slice(0, 240), session: sess };
      appendFileSync(undonePath(repo), JSON.stringify(entry) + '\n'); out.push(entry);
      rec.recordedFor = rec.atPrompt.at; writeFileSync(p, JSON.stringify(rec));
    }
  } catch { /* the ledger never fails a turn */ }
  return out;
}

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
  const seen = new Set(); const out = [];
  for (const e of readUndone(repo).reverse()) {
    if (!touched.has(e.file)) continue;
    const k = `${e.file}\n${e.first}`; if (seen.has(k)) continue; seen.add(k);
    out.push(`    - ${e.kind === 'part' ? 'partly undone' : 'undone'} here at your request (${localDay(e.at)}): ${e.added} line${e.added === 1 ? '' : 's'} starting \`${e.first}\` in ${e.file}${e.why ? `. Your words: "${e.why}"` : ''}`);
    if (out.length === 3) break;
  }
  return out;
}
