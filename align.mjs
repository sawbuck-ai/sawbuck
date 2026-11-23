// align.mjs   sawbuck align: where the work stands when Sawbuck joins late, or again later, said once to the person and
// once to the agent, so the two start from the same place. (His word, 2026-11-22: "we want some way to heal that
// disconnect".) A reading, never a verdict: nothing that happened before Sawbuck joined is sent back.
//
// Where the work began: the commit the repo was at when the current Claude Code session started (the first time
// written in its transcript; only that time and the folder are read, never a word), or the ref named with --since,
// or where the last align read to, or where this branch left the default branch, or the last 20 commits.
// What is read: each commit as `sawbuck contract --try` reads one (lookback.mjs: protected paths and the counts kept
// beside the tests, no test run), and over the whole range the engine's note on tests an earlier commit added that
// are all gone. Measured before it was written (proof-bench/align/noise.txt): on 271 ordinary pull requests by an
// agent these speak on 24 (9%). The old tests run on the new source (10 of 20 ordinary ones) is not run here: the
// reading says how to run it.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PW } from './bins.mjs';
import { readCommits, COUNTS } from './lookback.mjs';
import { protectedDirty } from './contract.mjs';
import { readGuard, writeGuard } from './guard.mjs';

const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim();
const tryGit = (repo, ...a) => { try { return git(repo, ...a); } catch { return ''; } };
const short = (sha) => (sha ? sha.slice(0, 8) : 'the first commit');
const LIMIT = 100;   // commits read at most; the reading says when there were more

// The time the newest Claude Code session in this repo began: its transcript's first line that carries a time and a
// folder inside the repo. Claude Code keeps a project's sessions under ~/.claude/projects/<the path, / as ->.
export function sessionStart(repo, home = homedir()) {
  const top = resolve(repo), names = [top.replace(/\//g, '-'), top.replace(/[^A-Za-z0-9]/g, '-')];
  const dirs = [...new Set(names)].map((n) => join(home, '.claude', 'projects', n)).filter((d) => existsSync(d));
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => join(d, f)))
    .map((f) => { try { return { f, t: statSync(f).mtimeMs }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    let head = ''; try { const fd = openSync(f, 'r'); const b = Buffer.alloc(256 * 1024); const n = readSync(fd, b, 0, b.length, 0); closeSync(fd); head = b.subarray(0, n).toString('utf8'); } catch { continue; }
    for (const line of head.split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e.timestamp !== 'string' || typeof e.cwd !== 'string') continue;
      const cwd = resolve(e.cwd);
      if (cwd === top || cwd.startsWith(top + sep)) return { at: e.timestamp, file: f };
      break;   // this session ran in another folder
    }
  }
  return null;
}

// where to read from: { sha (null: from the first commit), why }
export function startOf(repo, since, home) {
  if (since) {
    const sha = tryGit(repo, 'rev-parse', '--verify', '--quiet', `${since}^{commit}`);
    if (!sha) throw new Error(`${since} is not a commit here`);
    return { sha, why: `the commit you named (${since})` };
  }
  const last = readGuard(repo).align;
  if (last && last.head && last.head !== tryGit(repo, 'rev-parse', 'HEAD')) {
    try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', last.head, 'HEAD'], { stdio: 'ignore' }); return { sha: last.head, why: 'where the last align read to' }; } catch { /* history was rewritten since: read as if it never ran */ }
  }
  const s = sessionStart(repo, home);
  if (s) {
    const sha = tryGit(repo, 'rev-list', '-1', `--before=${s.at}`, 'HEAD', '--');
    return { sha: sha || null, why: `where this Claude Code session began (${s.at.replace('T', ' ').slice(0, 16)} UTC)` };
  }
  const branch = tryGit(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
  const remote = tryGit(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  for (const d of [remote, 'main', 'master'].filter(Boolean)) {
    if (d === branch || !tryGit(repo, 'rev-parse', '--verify', '--quiet', `${d}^{commit}`)) continue;
    const mb = tryGit(repo, 'merge-base', 'HEAD', d);
    if (mb && mb !== tryGit(repo, 'rev-parse', 'HEAD')) return { sha: mb, why: `where this branch left ${d}` };
  }
  const n = Number(tryGit(repo, 'rev-list', '--count', 'HEAD', '--')) || 0;
  return { sha: n > 20 ? tryGit(repo, 'rev-parse', 'HEAD~20') : null, why: n > 20 ? 'the last 20 commits' : 'every commit there is' };
}

// the commits from a start to HEAD, oldest first, merges left out, first parents; the first commit of a repo has
// nothing before it to be held against and is left out
const commitsFrom = (repo, start) => (tryGit(repo, 'log', '--no-show-signature', '--reverse', '--no-merges', '--first-parent', '--date=short', '--format=%H%x09%P%x09%ad%x09%s', start.sha ? `${start.sha}..HEAD` : 'HEAD', '--') || '').split('\n').filter(Boolean)
  .map((l) => { const [sha, parents, day, ...s] = l.split('\t'); return { sha, parent: (parents || '').split(' ')[0], day, subject: s.join(' ') }; }).filter((c) => c.parent);
const dirtyCount = (repo) => tryGit(repo, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).length;

// would attach read the work here and write its reading down? (attach --dry-run lists that file)
export function alignWould(repo) {
  try {
    if (readGuard(repo).align || !existsSync(join(repo, 'promptwheel.config.json')) || !tryGit(repo, 'rev-parse', 'HEAD')) return false;
    return commitsFrom(repo, startOf(repo)).length > 0 || dirtyCount(repo) > 0;
  } catch { return false; }
}

const COUNT_SAID = { test_count: ['the test count', 'fell'], assertions: ['the assertions', 'fell'], skipped_tests: ['the skipped tests', 'rose'], suppressions: ['the silenced warnings', 'rose'] };
const said = (b) => [
  ...b.worse.map((name) => { const [what, how] = COUNT_SAID[name] || [name, 'got worse']; const c = b.counts && b.counts[name]; return c ? `${what} ${how} from ${c[0]} to ${c[1]}` : `${what} ${how}`; }),
  ...(b.paths.length ? [`it changed ${b.paths.flatMap((p) => (p.files.length ? p.files : [p.name])).slice(0, 3).join(', ')}, which only a person changes`] : []),
].join('; ');

export async function align(repo, { since, home } = {}) {
  let cfg = null; try { cfg = JSON.parse(readFileSync(join(repo, 'promptwheel.config.json'), 'utf8')); } catch { /* no contract */ }
  if (!cfg) throw Object.assign(new Error('no contract here yet, so there is nothing to read the work against'), { noContract: true });
  const head = tryGit(repo, 'rev-parse', 'HEAD');
  if (!head) throw new Error('no commit here yet, so there is no work to read');
  const start = startOf(repo, since, home);
  const all = commitsFrom(repo, start);
  const commits = all.slice(-LIMIT);
  const { back, unread, signed } = await readCommits(repo, cfg, commits);
  // over the whole range: tests an earlier commit added, all gone at its end (the engine's note, 0.8.17)
  let takenOut = null;
  if (commits.length > 1) {
    try {
      const { check } = await import(pathToFileURL(PW).href);
      const counts = (cfg.metrics || []).filter((m) => m && COUNTS.has(m.name));
      takenOut = check({ repo, base: commits[0].parent, head, config: { ...cfg, mandates: [], metrics: counts }, detectGaming: false, repeat: 1 }).testsTakenOut || null;
    } catch { /* the note is left out, never guessed */ }
  }
  const dirty = dirtyCount(repo);
  let dirtyProtected = []; try { dirtyProtected = Object.keys(protectedDirty(repo, {})); } catch { /* none read */ }
  return { start, head, from: commits.length ? commits[0].parent : head, read: commits.length, total: all.length, back, unread, signed, takenOut, dirty, dirtyProtected };
}

// the same reading for the person (printed) and for the agent (handed over once, at its next prompt)
export function words(r) {
  const n = r.read, s = r.start;
  const head = `Read from ${short(s.sha)} (${s.why}) to ${short(r.head)}: ${n} commit${n === 1 ? '' : 's'}${r.total > r.read ? `, the last ${r.read} of ${r.total}` : ''}${r.dirty ? `, and ${r.dirty} changed file${r.dirty === 1 ? '' : 's'} not committed yet` : ''}.`;
  const items = r.back.map((b) => `- ${short(b.sha)} "${b.subject.slice(0, 60)}": ${said(b)}.`);
  if (r.takenOut) { const t = r.takenOut; items.push(`- an earlier commit (${t.at}) added ${t.added} test${t.added === 1 ? '' : 's'}, and ${t.added === 1 ? 'it is not' : 'none of them is'} in the work now: ${t.names.join(', ')}${t.more ? ` and ${t.more} more` : ''}.`); }
  if (r.dirtyProtected.length) items.push(`- not committed yet: ${r.dirtyProtected.slice(0, 3).join(', ')}, which only a person changes.`);
  if (r.unread) items.push(`- ${r.unread} commit${r.unread === 1 ? '' : 's'} could not be read.`);
  return { head, items };
}

export async function alignCli(repo, args) {
  const json = args.includes('--json');
  const i = args.findIndex((a) => a === '--since' || a.startsWith('--since='));
  const since = i < 0 ? null : (args[i].includes('=') ? args[i].slice(8) : args[i + 1]);
  if (i >= 0 && !since) { process.stderr.write('sawbuck align: --since needs a commit, a branch or a tag\n'); process.exit(64); }
  let r; try { r = await align(repo, { since }); } catch (e) { process.stderr.write(`sawbuck align: ${e.message}${e.noContract ? '. Give it one first: sawbuck contract' : ''}\n`); process.exit(64); }
  deliver(repo, r, { json });
}

// attach: Sawbuck joining a repo that already has work in it says once where that work stands. Quiet where there is no
// contract yet, nothing to read, or an align already ran here. Never fails attach.
export async function alignOnAttach(repo) {
  try {
    if (readGuard(repo).align || !existsSync(join(repo, 'promptwheel.config.json'))) return;
    const r = await align(repo, {});
    if (!r.read && !r.dirty) return;
    process.stdout.write('\n'); deliver(repo, r, { onAttach: true });
  } catch { /* attach is done; the reading can be had with sawbuck align */ }
}

function deliver(repo, r, { json, onAttach } = {}) {
  const { head, items } = words(r);
  const clean = !items.length;
  const forPerson = ['sawbuck align: where the work stands', `  ${head}`, ...(clean ? ['  Nothing of note: no count kept beside the tests got worse, and nothing that only a person changes was changed.'] : items.map((x) => `  ${x}`)),
    ...(clean && onAttach ? [] : [   // joining work with nothing of note in it takes two lines, no more
      `  A reading, not a verdict: nothing from before is sent back. The tests were not run. To run the old tests on the new source too: sawbuck check --base ${short(r.from)}`,
      '  The rules you told Claude before Sawbuck joined: sawbuck rules --prepare gathers your messages so an agent can propose them, and you keep only those with two of your own quotes.'])];
  // silent on a pass: with nothing of note the agent is handed nothing, so its context grows by nothing
  const forAgent = clean ? null
    : ['▣ align (sawbuck) · where the work stood when Sawbuck joined, said once:', `  ${head}`, ...items.map((x) => `  ${x}`),
      '  Nothing from before is sent back. In your answer, tell the person about each line above and ask whether it was meant.'].join('\n');
  writeGuard(repo, { align: { at: new Date().toISOString(), since: r.start.sha, head: r.head, agent: forAgent, delivered: forAgent ? null : 'nothing of note, so nothing was handed over' } });
  if (json) process.stdout.write(JSON.stringify({ ...r, said: { head, items } }, null, 2) + '\n');
  else process.stdout.write(forPerson.join('\n') + '\n');
}
