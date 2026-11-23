// began.mjs: where a turn began, when there was no repository to write it in.
//
// The baseline of a turn is written in the repository (the state file, and a second copy in the git folder). Hooks
// that run everywhere (attach --user, the plugin's) also run in a folder that is no repository, and there the prompt
// hook had nowhere to write. So the end of a turn that ran `git init` and `sawbuck contract` found a repository, a
// contract and no baseline, judged everything by the rules as they were now, and sent the turn back for the contract
// it had just been asked to write. The next prompt would not take up a file that had been sent back, so every turn
// was sent back until a first commit (proof-bench/no-baseline, C1, 2026-11-22 and 23).
//
// Since 0.2.6 the prompt hook, where it finds no repository, leaves one small file in the person's own Sawbuck folder
// (~/.sawbuck/began/): this session, this folder, this time. The end of a turn that has no baseline and no commit, in
// a repository at or above that folder, takes it for its baseline: nothing stood, and the rules the turn wrote do not
// judge it, as in a repository whose turn began with no contract. The next prompt in a repository removes the file.
//
// What it is not: a way to end a turn unjudged in a repository that was there. It is read only where there is no
// baseline at all and no commit, and only this session's, for this folder. Without it "no baseline" goes on meaning
// "judge everything", so removing both copies of the record frees nothing. It is one more file an agent that reaches
// it without naming it could write; the hold asks the person before a command or an edit tool that names the folder.
// No model, no network. Never throws.
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs';

export const beganDir = (home = homedir()) => join(home, '.sawbuck', 'began');
const fileOf = (session) => join(beganDir(), `${createHash('sha256').update(String(session)).digest('hex').slice(0, 32)}.json`);
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;   // a session that never came back to a repository leaves its file; it is cleared here

// the prompt hook, in a folder that is in no repository
export function noteBegan(session, folder, at = new Date().toISOString()) {
  if (!session) return;
  try {
    const dir = beganDir(); mkdirSync(dir, { recursive: true });
    for (const n of readdirSync(dir)) { try { if (Date.now() - statSync(join(dir, n)).mtimeMs > KEEP_MS) rmSync(join(dir, n), { force: true }); } catch { /* another hook took it */ } }
    writeFileSync(fileOf(session), JSON.stringify({ session: String(session), folder: real(folder), at }) + '\n');
  } catch { /* the hook goes on without it */ }
}

// the prompt hook, in a repository: this session's turn begins here, on the record the repository keeps
export function forgetBegan(session) {
  if (!session) return;
  try { rmSync(fileOf(session), { force: true }); } catch { /* nothing to forget */ }
}

// the end of a turn: did this session's prompt begin in `repo`, or in a folder below it, while it was in no repository?
// Returns the line it left ({ session, folder, at }), or null.
export function beganWithoutRepo(session, repo) {
  if (!session) return null;
  try {
    const w = JSON.parse(readFileSync(fileOf(session), 'utf8'));
    if (!w || w.session !== String(session) || typeof w.folder !== 'string' || typeof w.at !== 'string') return null;
    const rel = relative(real(repo), w.folder);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;   // the prompt began somewhere else
    return w;
  } catch { return null; }
}
