// One read of what Sawbuck has here, shared by the statusline and `sawbuck status`. Files only, no git and no model.
// state: watching (hooks wired for this repo), ready (checkable, not wired), memory (history only), or empty.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const WEEK = 7 * 864e5;
// A path the way git names it: through the real folders, not through a symlink someone walked in by. On a Mac the temp
// folder and /tmp are both reached through one, and a tool call may name a file either way. A file that does not exist
// yet is resolved from the nearest folder that does. Found when the suite first ran on a Mac (2026-11-16).
export function realPath(p) {
  const asked = resolve(String(p || '')); let cur = asked; const tail = [];
  for (;;) {
    try { const real = realpathSync(cur); return tail.length ? join(real, ...tail) : real; }
    catch { const up = dirname(cur); if (up === cur) return asked; tail.unshift(basename(cur)); cur = up; }
  }
}
export const OURS = /sawbuck\.mjs|npx (?:--\S+ )*-y sawbuck@/;   // a hook of ours: the baked path, or the portable form --shared writes
export const S_START = '# >>> sawbuck >>>';
const text = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
// our hooks in a Claude Code settings file: under "hooks", so a permission that names sawbuck is not wiring
export const hooksIn = (f) => { try { return OURS.test(JSON.stringify(JSON.parse(readFileSync(f, 'utf8')).hooks || {})); } catch { return false; } };

// Which hooks are wired for this repo: ours in the project settings, our block in the post-commit hook, or ours in
// the user-level settings. '' when none are, whatever record an earlier attach left on disk.
export function wiredBy(repo, home = homedir()) {
  if (['settings.local.json', 'settings.json'].some((f) => hooksIn(join(repo, '.claude', f)))) return 'project';
  // .git is a file in a submodule or a linked worktree. A linked worktree has no hooks of its own, and its commits are not checked.
  const m = /^gitdir: (.+)$/m.exec(text(join(repo, '.git')));
  if (text(join(m ? resolve(repo, m[1].trim()) : join(repo, '.git'), 'hooks', 'post-commit')).includes(S_START)) return 'git';
  return hooksIn(join(home, '.claude', 'settings.json')) ? 'user' : '';
}

// WHAT A PERSON TYPES IS KEPT ONLY WHERE THE HOOK LINES SAY `--words` (0.2.0). A plain attach keeps none of it: no
// prompt text in the record, an undo without the person's words, nothing handed on to any notes, no kept steers read.
// `sawbuck attach --words` writes the word onto the hook lines. Nothing turns it on for a person: neither plugin's
// setup passes it (his word, 2026-11-17: storing is never a default). The lines are the one thing every way of attaching has (the
// project file, a team file a clone brings, the user-level file). Read by `status` and by attach itself.
export const WORDS = '--words';
const hookCommands = (f) => { try { return Object.values(JSON.parse(readFileSync(f, 'utf8')).hooks || {}).flat().flatMap((h) => (h && Array.isArray(h.hooks)) ? h.hooks : []).map((x) => String((x && x.command) || '')); } catch { return []; } };
export const wordsIn = (f) => hookCommands(f).some((c) => OURS.test(c) && /\bturn --hook\b/.test(c) && /(^|\s)--words(\s|;|$)/.test(c));
export function keepsWords(repo, home = homedir()) {
  return [join(repo, '.claude', 'settings.local.json'), join(repo, '.claude', 'settings.json'), join(home, '.claude', 'settings.json')].some(wordsIn);
}

export function repoState(repo) {
  const record = (f) => { try { return JSON.parse(readFileSync(join(repo, '.sawbuck', f), 'utf8')); } catch { return null; } };
  const has = (f) => existsSync(join(repo, f));
  const results = record('results.json') || {};
  const caught = (results.regressions || 0) + (results.gamed || 0) + (results.mandates || 0);
  const hasConfig = has('promptwheel.config.json');
  const armed = hasConfig || has('package.json');
  const wired = wiredBy(repo);
  const state = wired ? 'watching' : armed ? 'ready' : (has('LOGBOOK.md') || has('events.jsonl')) ? 'memory' : '';
  // the reins engine's file; reins does the model work, never sawbuck. A rate nobody has updated for a week is
  // history, not a reading: the judge was turned off, or the plugin is not running.
  const s = record('steer.json');
  const live = s && s.scored && !(s.at && Date.now() - Date.parse(s.at) > WEEK);
  const steer = live ? { rate: Math.round(((s.ema != null ? s.ema : s.steeringRate) || 0) * 100), scored: s.scored } : null;
  return { results, caught, hasConfig, armed, wired, state, steer };
}
