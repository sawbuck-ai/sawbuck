// contract.mjs: the contract's hard rules, read the way promptwheel reads them. Shared by the CLI
// (frame / turn) and the Stop hook (the turn-level wall), so there is one resolver and one renderer.
// Read-only, never throws, zero-dep.
import { readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, posix } from 'node:path';
import { execFileSync } from 'node:child_process';

const gitOut = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
// File names from git, NUL-separated (the command must take -z). Read as lines, a name that holds a byte above 127, a
// double quote, a backslash or a tab comes back inside quotes with the bytes escaped ("a\303\261adir.yml", git's
// core.quotePath), and that string is no file: a new workflow named so matched no protected path, at the end of a turn
// or on a commit. Throws as git does.
// Git refuses a repo that another user owns ("dubious ownership", since git 2.35.2): a dev container with a mounted
// repo, a folder root made. Every git call fails there, and "not a git repo, run git init" was the wrong thing to
// say. Returns what to tell the person, with git's own line for it; '' when git reads the folder or it is no repo.
export function gitRefuses(dir) {
  try { execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }); return ''; }
  catch (e) {
    const err = String((e && e.stderr) || '');
    if (!/dubious ownership/.test(err)) return '';
    const line = (/git config --global --add safe\.directory \S.*/.exec(err) || [`git config --global --add safe.directory ${dir}`])[0].trim();
    return `git refuses this repo because another user owns it ("dubious ownership"), so nothing here can be checked. If that is expected (a container with a mounted repo), tell git it is safe: ${line}`;
  }
}
// -z goes right after the command, never at the end: a call that names a revision ends with `--`, and a word after
// that is a path. (Until 0.2.6 it was added last, and no such call had a `--`: see dirtyNames.)
export const gitNames = (repo, args) => execFileSync('git', [args[0], '-z', ...args.slice(1)], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
const validMandate = (m) => m && Array.isArray(m.paths) && m.paths.some((s) => typeof s === 'string' && s.trim());
const pathsOf = (m) => m.paths.filter((s) => typeof s === 'string' && s.trim());

// mandates accumulate down the `extends` chain; a local mandate of the same name overrides an inherited one
export function resolvedMandates(repo) {
  const seen = new Set(); const byName = new Map();
  const load = (file) => {
    const p = resolve(file); if (seen.has(p)) return; seen.add(p);
    let cfg = null; try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { return; }
    if (!cfg || typeof cfg !== 'object') return;
    const ext = cfg.extends == null ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
    for (const e of ext) if (typeof e === 'string') load(resolve(dirname(p), e));
    for (const m of (Array.isArray(cfg.mandates) ? cfg.mandates : [])) if (m && m.name) byName.set(String(m.name), m);
  };
  load(join(repo, 'promptwheel.config.json'));
  return [...byName.values()].filter(validMandate);
}

// the mandates COMMITTED at `ref` (default HEAD), read with `git show` and following `extends` inside
// the repo, the way promptwheel reads a gate at a ref. [] when there is no config there.
export function resolvedMandatesAt(repo, ref = 'HEAD') {
  const seen = new Set(); const byName = new Map();
  const load = (p) => {
    if (seen.has(p)) return; seen.add(p);
    let raw = null; try { raw = gitOut(repo, ['show', `${ref}:${p}`]); } catch { return; }
    let cfg = null; try { cfg = JSON.parse(raw); } catch { return; }
    if (!cfg || typeof cfg !== 'object') return;
    const ext = cfg.extends == null ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
    for (const e of ext) if (typeof e === 'string' && !isAbsolute(e)) load(posix.normalize(posix.join(posix.dirname(p), e.split('\\').join('/'))));
    for (const m of (Array.isArray(cfg.mandates) ? cfg.mandates : [])) if (m && m.name) byName.set(String(m.name), m);
  };
  load('promptwheel.config.json');
  return [...byName.values()].filter(validMandate);
}

// the rules in force for a turn: the working-tree contract, plus every committed mandate the working
// tree does not carry unchanged (same name, same paths). Editing the contract in the working tree
// does not lift a committed rule, so a change cannot disarm the wall and break it in one turn; a
// rule that comes only from the commit is tagged `committed`.
export function mandatesInForce(repo, ref = 'HEAD') {
  const wt = resolvedMandates(repo);
  const key = (m) => JSON.stringify([String(m.name), pathsOf(m).sort()]);
  const have = new Set(wt.map(key));
  const committed = resolvedMandatesAt(repo, ref).filter((m) => !have.has(key(m))).map((m) => ({ ...m, committed: true }));
  return [...wt, ...committed];
}

// the paths among `paths` that a mandate in force covers (any rule, working tree or committed). `list`: the rules to
// read instead, when the caller judged by rules of its own (the end of a turn judges by the rules the turn began with,
// and a turn that deleted a contract not yet committed leaves none in force to name what it changed).
export function protectedAmong(repo, paths, list = null) {
  const res = (Array.isArray(list) ? list.filter(validMandate) : mandatesInForce(repo)).flatMap((m) => pathsOf(m).map(globToRe));
  return paths.filter((f) => res.some((re) => re.test(f)));
}

// a working-tree file's content hash as git would store it; 'deleted' when it is gone. With `store`,
// the content is also written into the object database (`hash-object -w`), so a person's edit that
// the baseline recorded can be restored by hash later even after the agent overwrote the file.
// A link is hashed as git keeps it: the name it points to, not what is there. `git hash-object <path>` follows a link,
// so until 0.2.6 a link's hash here never matched the blob a commit holds for it, and a person's uncommitted link under
// a protected name that a turn only committed read as changed by the turn (proof-bench/no-baseline, E2).
export function hashOf(repo, file, { store = false } = {}) {
  const w = store ? ['-w'] : [];
  let link = null;
  try { if (lstatSync(join(repo, file)).isSymbolicLink()) link = readlinkSync(join(repo, file), { encoding: 'buffer' }); } catch { return 'deleted'; }
  try {
    if (link) return execFileSync('git', ['hash-object', ...w, '--stdin'], { cwd: repo, input: link, stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8').trim();
    return gitOut(repo, ['hash-object', ...w, '--', file]).trim();
  } catch { return 'deleted'; }
}

// Files hidden from git (skip-worktree, assume-unchanged) whose content is not what HEAD holds. `git diff` and `git
// status` say nothing about a hidden file, so a protected path that a turn hid and then edited was not seen at the end of
// the turn (found by holding Sawbuck to another session's attack list, 2026-11-21). Only hidden files are read.
export function hiddenChanged(repo) {
  let rows = []; try { rows = gitNames(repo, ['ls-files', '-v']); } catch { return []; }
  const out = [];
  for (const l of rows) { if (!/^[a-zS] /.test(l)) continue; const f = l.slice(2); if (hashOf(repo, f) !== blobAt(repo, 'HEAD', f)) out.push(f); }
  return out;
}

// Every path that is not as HEAD holds it: changed, untracked, or hidden from git and changed. The baseline a prompt
// takes and the end of a turn both ask this, and they must get one answer, so both ask it here.
// Each question is put to git by itself, and one that cannot be answered adds nothing. Until 0.2.5 the baseline asked
// them in one go and threw every answer away when the first failed, which it does wherever there is no HEAD (a
// repository with no commit yet, an orphan branch just made), while the end of a turn asked each alone. So in a new
// repository the baseline was empty, and every protected file there (the contract `sawbuck contract` had just
// written) read as changed in the turn, at every turn, until a first commit. Found in a real session,
// proof-bench/live/rehearse-0.2.5.
// What this does NOT read, where there is no HEAD: what is staged. (Listing the index there was tried the same night
// and taken out: after `git checkout --orphan` the index holds every file, and a turn that had edited nothing was
// sent back for the contract.)
// A REVISION IS FOLLOWED BY `--`, HERE AND IN EVERY GIT CALL THAT NAMES ONE. Without it git has to guess whether a word
// is a revision or a path, and refuses when a file of that name exists ("ambiguous argument 'HEAD': both revision and
// filename"). Until 0.2.6 a turn that made an empty file named HEAD at the top and then edited a protected path was not
// sent back, in any repository: the question was refused, and a refused question was read here as "nothing changed".
// The same with a file named as the commit the turn began at. Found 2026-11-23 (proof-bench/no-baseline, N31, X3).
export function dirtyNames(repo) {
  const names = (...a) => { try { return gitNames(repo, a); } catch { return []; } };
  return [...new Set([...names('diff', '--name-only', '--no-renames', 'HEAD', '--'), ...names('ls-files', '--others', '--exclude-standard'), ...hiddenChanged(repo)])];
}

// WHAT A TURN BEGAN WITH (0.2.6). Until then "changed in this turn" was whatever git listed at the end of the turn,
// against HEAD, and two things were on no list: the contract while it is not yet committed, once a turn deleted it or
// hid it in .gitignore; and anything at all of a turn that ends on a branch with no commit (git checkout --orphan, then an
// edit). Now the contract's own files are read by name, and a turn that began on a commit is read against that commit
// even where HEAD names none at its end. Which reading is used is decided by the baseline, never by whether HEAD exists at
// the end: a first try at this (the night of 0.2.5) asked the second question, and sent back a turn that had only made an
// orphan branch. NOT read, as in 0.2.5: with no commit yet, a protected file other than the contract that is staged, put
// in a first commit, deleted or hidden while untracked (proof-bench/no-baseline, PLAN.md, amendment of 2026-11-23).
const hasHead = (repo) => { try { gitOut(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']); return true; } catch { return false; } };
// the contract's own files are read by name: a turn that adds one to .gitignore does not take it out of the next baseline
const OWN_FILES = ['promptwheel.config.json', 'sawbuck.config.json'];
const here = (repo, f) => { try { lstatSync(join(repo, f)); return true; } catch { return false; } };

// Every path a baseline may have to hold: what is not as HEAD holds it (dirtyNames), and the contract's own files
// wherever they are there and not as HEAD holds them (with no commit yet: wherever they are there), whether git lists
// them or not. A first form (2026-11-23) listed everything git knew where there was no commit, and read all of it by
// content at the end of the turn: a second reader showed it sent back a person's ordinary work there (a staged file's
// unstaged edit put back, a pull into a new repository, a .gitattributes added). Taken out again; see sinceBegan.
export function standingNames(repo) {
  const out = dirtyNames(repo);
  const head = hasHead(repo);
  for (const f of OWN_FILES) if (!out.includes(f) && here(repo, f) && (!head || hashOf(repo, f) !== blobAt(repo, 'HEAD', f))) out.push(f);
  return out;
}

// The two lists the wall reads at the end of a turn: `dirty`, every path to hold against the baseline's files, and
// `committedSince`, every path a commit made in the turn may have changed. `base` is the baseline (null when there is
// none on record), `head` the commit HEAD names now ('' when it names none).
export function sinceBegan(repo, base, head) {
  const names = (...a) => { try { return gitNames(repo, a); } catch { return []; } };
  const files = (base && base.files && typeof base.files === 'object') ? base.files : {};
  const began = (base && typeof base.sha === 'string') ? base.sha : null;
  let dirty; let committedSince = [];
  if (began && !head) {
    // it began on a commit and HEAD names none now (an orphan branch made in the turn): the working tree against the
    // commit it began at, for what is there. What is gone is not read: `git switch --orphan` empties the tree itself.
    dirty = [...names('diff', '--name-only', '--no-renames', '--diff-filter=d', began, '--'), ...names('ls-files', '--others', '--exclude-standard')];
  } else {
    dirty = dirtyNames(repo);
    if (began && head && began !== head) committedSince = names('diff', '--name-only', '--no-renames', began, 'HEAD', '--');
  }
  // the contract's own files, where the baseline holds them, are read whether or not git still lists them: deleted,
  // hidden in .gitignore, staged, or carried into a first commit. Only those. A first form read every protected file the
  // baseline held this way, and a second reader showed it sent back a person's untracked file that `git stash -u` or
  // `git clean -fd` took out of the tree, and a dependency's Dockerfile under node_modules in a new repository.
  // And only while the contract is not yet committed where the turn began: a committed one that changes shows in git's
  // own lists, and one put back to what was committed (a person's edit stashed or discarded) is read as 0.2.5 read it.
  for (const f of OWN_FILES) if (Object.prototype.hasOwnProperty.call(files, f) && !dirty.includes(f) && (!began || blobAt(repo, began, f) === '')) dirty.push(f);
  return { dirty: [...new Set(dirty)], committedSince };
}

// the protected paths that are dirty right now, each with its content hash: the baseline `turn`
// records when a prompt begins, so the Stop hook counts only what the turn itself changed and leaves
// a person's own pre-existing edits alone. {} when nothing protected is dirty (or not a git repo).
// `store` keeps each file's content in the object database (see hashOf), which the baseline does.
export function protectedDirty(repo, { store = false } = {}) {
  const changed = standingNames(repo);
  if (!changed.length) return {};
  const res = mandatesInForce(repo).flatMap((m) => pathsOf(m).map(globToRe));
  const out = {};
  for (const f of changed) if (res.some((re) => re.test(f))) out[f] = hashOf(repo, f, { store });
  return out;
}

// the blob hash a tracked path has at `ref` ('' when the path is not there)
export function blobAt(repo, ref, file) {
  try { return gitOut(repo, ['rev-parse', `${ref}:${file}`]).trim(); } catch { return ''; }
}

// the same glob dialect as promptwheel's evaluatorPaths / mandates (ported verbatim): a bare name
// matches that basename at any depth; a pattern with "/" is anchored at the repo root; "*" stops at
// "/", "**" crosses it, "?" is one char; a leading "/" anchors to the root explicitly.
export function globToRe(glob) {
  let g = glob; const anchored = g.startsWith('/'); if (anchored) g = g.slice(1);
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\x00/g, '.*');
  const pre = (anchored || glob.includes('/')) ? '^' : '(^|/)';
  return new RegExp(`${pre}${body}$`);
}

// which changed paths violate which mandate: [{ name, reason, files, committed? }]. The rules are the
// working tree's plus the committed ones (mandatesInForce); pass { ref: null } for the working tree alone.
export function mandateHits(repo, changedPaths, opts = {}) {
  const list = opts.list || (opts.ref === null ? resolvedMandates(repo) : mandatesInForce(repo, opts.ref || 'HEAD'));
  const out = [];
  for (const m of list) {
    const res = pathsOf(m).map(globToRe);
    const files = changedPaths.filter((f) => res.some((re) => re.test(f)));
    if (!files.length) continue;
    const prev = out.find((h) => h.name === String(m.name));
    if (prev) {
      prev.files = [...new Set([...prev.files, ...files])].slice(0, 20);
      if (!prev.reason && m.reason) prev.reason = String(m.reason).slice(0, 300);
      if (m.committed) prev.committed = true;   // the committed version of the rule hit too: say so
      continue;
    }
    out.push({ name: String(m.name), reason: m.reason ? String(m.reason).slice(0, 300) : '', files: files.slice(0, 20), ...(m.committed ? { committed: true } : {}), ...(m.allowable ? { allowable: m.allowable } : {}) });
  }
  return out;
}

// the prompt face of the contract: one compact block, or '' when there is no contract
export function frameBlock(repo) {
  const mandates = resolvedMandates(repo);
  if (!mandates.length) return '';
  const lines = mandates.map((m) => `  ${m.paths.filter((s) => typeof s === 'string' && s.trim()).join(' · ')}${m.reason ? `  (${String(m.reason).slice(0, 160)})` : ''}`);
  return '▣ rules (sawbuck) · checked on every turn:\n  protected, do not touch:\n' + lines.join('\n');
}

// the repo's architecture lock, if the supply-chain preset is installed: structure the lock has not seen, and a
// fingerprint of the resolved dependency tree. null when there is no lock here. Read-only, and fast (under 200 ms
// on the largest repo tried), so it can run at every turn end.
export function lockState(repo) {
  const tool = join(repo, '.promptwheel', 'packs', 'supply-chain', 'lock.mjs');
  if (!existsSync(tool) || !existsSync(join(repo, 'promptwheel.lock.json'))) return null;
  const run = (...a) => execFileSync(process.execPath, [tool, ...a], { cwd: repo, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try { return { drift: JSON.parse(run('drift', '.', '--json')), pins: run('pins', '.') }; } catch { return null; }
}

// What `git hash-object <path>` gives, following a link: how 0.2.5 hashed one. A baseline taken by that version and read
// at the end of a turn by this one is compared both ways, so an untouched link is not sent back across the upgrade.
export function hashFollowing(repo, file) {
  try { return gitOut(repo, ['hash-object', '--', file]).trim(); } catch { return 'deleted'; }
}
export function isLink(repo, file) { try { return lstatSync(join(repo, file)).isSymbolicLink(); } catch { return false; } }
