// The end-of-turn wall's memory of a change it already sent back (0.2.9). A protected change is known by what it did
// to its file, not by the whole file, so the person's own edits around it, a commit that carries it, a reason, a new
// session or /clear do not make it new, and do not take it in either. Proof and plan: proof-bench/wall-029.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// a stored blob's bytes; nothing for a file that was not there
const blob = (repo, h) => (!h || h === 'deleted') ? Buffer.alloc(0)
  : execFileSync('git', ['cat-file', 'blob', h], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 });

// What the blob `cur` holds with the change `before -> flagged` taken back out, line by line (git merge-file applies the
// change from `flagged` back to `before` onto `cur`). '' when the change is not in `cur` (taking it out changes
// nothing); null when the two cannot be told apart (edits on the same lines, a binary file, a git error), so the caller
// takes nothing of it in; else the hash of the result, stored in the object database.
export function withoutChange(repo, cur, flagged, before) {
  if (!cur || !flagged || cur === 'deleted' || flagged === 'deleted') return null;
  let d = '';
  try {
    const c = blob(repo, cur), f = blob(repo, flagged), b = blob(repo, before);
    if (c.includes(0) || f.includes(0) || b.includes(0)) return null;   // binary: not by lines
    d = mkdtempSync(join(tmpdir(), 'sawbuck-wall-'));
    writeFileSync(join(d, 'cur'), c); writeFileSync(join(d, 'flagged'), f); writeFileSync(join(d, 'before'), b);
    let out;
    try { out = execFileSync('git', ['merge-file', '-p', '--quiet', join(d, 'cur'), join(d, 'flagged'), join(d, 'before')], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }); }
    catch { return null; }   // a conflict (the exit status is how many) or an error
    if (out.equals(c)) return '';
    return execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: out, stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch { return null; } finally { if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* a temp folder */ } } }
}

// Whether the file, holding `cur` now, holds the change `told` remembers and nothing else since a start of `start`:
// taking that change out of `cur` gives the start back. A file the change itself created starts as no file.
export function sameChange(repo, told, cur, start) {
  if (!told || !told.flagged || !cur) return false;
  if (told.flagged === cur && (told.before || '') === (start || '')) return true;
  const out = withoutChange(repo, cur, told.flagged, told.before);
  if (out === null || out === '') return false;   // cannot tell, or that change is no longer in it: a new change
  if (out === start) return true;
  if (!start || start === 'deleted') { try { return blob(repo, out).length === 0; } catch { return false; } }
  return false;
}
