#!/usr/bin/env node
// sawbuck contract: give a repo its first rules with one command. Keeps whatever config is already here (and adds no
// tests to it); with no config it writes one with your detected tests. Adds the protected paths and the written rule, which is what changes the agent (the pressure bench: 11 of
// 20 to 0 of 20). --full adds the supply-chain guards, the repo lock and a CI check (github.com origin; a real test command, or --comment-only). Zero-LLM. Re-running changes
// nothing. Protected product code (auth, billing) is suggested, never added: freezing those is a person's decision.
import './pipe.mjs';
import { ensureExcluded } from './exclude.mjs';
import { writeAgentBlock } from './agent-block.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync, mkdirSync, readdirSync, statSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PW } from './bins.mjs';
import { cli } from './copies.mjs';
import { mandateHits, gitNames, globToRe } from './contract.mjs';
import { readCommits } from './lookback.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The check's own action is pinned by commit, like GitHub's: the commit the engine's release tag points at. A moving
// tag with write access to pull requests is the kind of thing the unpinned_execution guard exists to flag.
const PKG = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const ACTION = `promptwheel-ai/promptwheel@${PKG.promptwheelAction} # v${PKG.dependencies.promptwheel}`;
// A fix in the engine reaches a pull-request check only through the commit its workflow pins, and this command writes
// that workflow once and never again. So it says when the one here pins an older engine than this release. Words only:
// a workflow file is a protected path, and the person's. A workflow on a tag (@v0) follows the tag and needs no word.
function olderCi(wf) {
  let text = ''; try { text = readFileSync(wf, 'utf8'); } catch { return ''; }
  const m = text.match(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*promptwheel-ai\/promptwheel@([0-9a-f]{40})[ \t]*#[ \t]*v(\d+)\.(\d+)\.(\d+)/m);
  if (!m || m[1] === PKG.promptwheelAction) return '';
  const has = [m[2], m[3], m[4]].map(Number), want = String(PKG.dependencies.promptwheel).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (has[i] !== want[i]) return has[i] < want[i] ? `v${has.join('.')}` : '';
  return '';
}
const repo = process.argv[2] || process.cwd();
// --try[=N]: the contract a real run would write, held against the last N commits (20 unless said, 200 at most).
// It is a dry run that ends in a different report: nothing is written.
const tryArg = process.argv.find((a) => /^--try(=\d{1,3})?$/.test(a));
const tryN = tryArg ? Math.max(1, Math.min(200, Number(tryArg.split('=')[1]) || 20)) : 0;
const dry = process.argv.includes('--dry-run') || tryN > 0;
const strict = process.argv.includes('--strict');
// --say-why: for a repo where nobody stands at the merge. The three counts of the tests take a reason written in a
// commit of the change (kept on the record). The protected paths still take a person's.
// --solo: for a repo with one person in it. What --say-why does, and on a pull request the opener's own comment
// counts ("allowFromAuthor": true). A sent-back pull request is let through by someone who did not open it, and
// where the person is the opener and the agent works under the same account GitHub cannot tell the two apart. So
// what can be kept there is a reason, written down. The output says so in those words.
const solo = process.argv.includes('--solo');
const sayWhy = process.argv.includes('--say-why') || solo;
// --comment-only: with --full, the workflow it writes never fails a pull request. The comment says what would have
// been sent back. For trying the check on real pull requests before it counts. (--try is a different thing: the
// contract held against your last commits, nothing written.)
const commentOnly = process.argv.includes('--comment-only');
const WITH = `with: { inconclusive: pass${commentOnly ? ', comment-only: true' : ''} }`;
const TESTS3 = ['test_count', 'skipped_tests', 'assertions'];
const full = process.argv.includes('--full') || strict;
// a new contract starts by watching: everyday change shows as a note. Protected paths, install scripts and sources
// outside the registry still fail from day one. --strict holds them all, and makes the notes of an earlier --full block.
// `suppressions` is the one count `init` writes as a note for a change that wins nothing (one more lint silencer is a person's
// ordinary work far more often than a cheat: proof-bench/contract-replay, 13 of 340 real commits sent back when it always
// blocked, and none of them beside a win). --strict makes it block always.
const REPORT = new Set(['dependency_entries', 'lock_drift', 'pins_changed', 'unpinned_execution', 'install_policy_gaps', 'suppressions']);
// what --strict asks of a rewritten test, said in its own words: a setting, not a guard (second read of 0.2.8: it was
// counted among "guards that were notes now block", and a dry run said only that the contract changed)
const REWRITES = 'on a pull request, a test the base had that a later commit rewrote after the source changed now waits for a person\'s reason ("testRewrites": "ask")';
// The scripts a test command runs by name, which an agent could cut short as easily as a test. On wavecutter
// (2026-11-23) a harness ran `bash judge-test.sh`; the gate knows a test script by a few names only, so the script was
// source, and cut to `exit 0` after a planted fault the change read "verified". Named in evaluatorPaths, the cut reads
// gamed. A shell script counts, or a file whose name says it tests or checks; a build step the command also runs stays
// source. Only what the command runs (after an interpreter, or as the command itself), never its other arguments.
const SCRIPT_INTERP = /^(?:ba|z|da|k)?sh$|^(?:node|bun|deno|python3?|ruby|perl|php|tsx|ts-node)$/;
function scriptsRun(repo, cmds) {
  const out = new Set();
  for (const cmd of cmds) for (const simple of String(cmd || '').split(/&&|\|\||[;|\n(){}]/)) {
    const words = simple.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '')).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();   // FOO=bar before the command
    if (!words.length) continue;
    let i = 0;
    if (SCRIPT_INTERP.test(words[0].split('/').pop())) { i = 1; while (i < words.length && words[i].startsWith('-')) i++; }
    const f = (words[i] || '').replace(/^\.\//, '');
    if (!f || f.startsWith('-') || f.startsWith('/') || f.split('/').includes('..') || /[$*?`]/.test(f)) continue;
    if (!/\.(?:sh|bash|zsh)$/.test(f) && !/test|spec|check|judge/i.test(f.split('/').pop())) continue;
    try { if (statSync(join(repo, f)).isFile()) out.add(f); } catch { /* not a file in this repo */ }
  }
  return [...out].sort();
}
// Tests need their dependencies, so an npm lockfile gets an install, with no scripts. Elsewhere tests may not run in
// CI, so inconclusive does not fail the job: protected paths are checked either way, and a gamed or failed verdict still fails.
const workflow = (npm) => `# Written by sawbuck contract. Checks every pull request against the contract in promptwheel.config.json.
name: Sawbuck
on: pull_request
permissions: { contents: read, pull-requests: write }
# a new push to the pull request stops the check of the push before it
concurrency: { group: "\${{ github.workflow }}-\${{ github.ref }}", cancel-in-progress: true }
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with: { fetch-depth: 0 }
${npm ? `      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with: { node-version: 22 }
      - run: npm ci --ignore-scripts
` : ''}      - uses: ${ACTION}
${commentOnly ? `        # comment-only: no pull request fails here. The comment says what would have been sent back.
        # Take "comment-only: true" out to make the check count.
` : ''}        ${WITH}
`;
const cfgPath = join(repo, 'promptwheel.config.json');
// The files signing writes that this repo's ignore rules hide from git: git status does not show them and git add skips
// them, so "commit these" would be a dead end. Some repos ignore everything their .gitignore does not list (npm's do).
// git check-ignore leaves tracked files out, and exits 1 when none of these is ignored.
const SIGNED_FILES = ['AGENTS.md', 'promptwheel.config.json', 'promptwheel.lock.json', '.github/workflows/sawbuck.yml', '.promptwheel/packs/supply-chain/scan.mjs'];
const hiddenFromGit = (root) => { try { return execFileSync('git', ['-C', root, 'check-ignore', '--', ...SIGNED_FILES.filter((f) => existsSync(join(root, f)))], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).map((f) => f.replace(/^(\.promptwheel\/packs\/supply-chain\/).*/, '$1')); } catch { return []; } };
// npm's template-oss (node-semver, npm/cli and that family) runs a check inside `npm test` that fails when a tracked file
// matches .gitignore. There `git add -f` makes the repo's own tests fail, and every check after signing reads "could not
// measure" (seen on node-semver, 2026-11-12). The way in is that repo's own allowlist; tried in a clean container.
const templateOss = (root) => { try { const p = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); return !!p.templateOSS || Object.values(p.scripts || {}).some((v) => /template-oss-check/.test(String(v))); } catch { return false; } };
const addByName = (files, root) => (templateOss(root)
  ? `  This repo's ignore rules hide ${files.join(' and ')} from git, and its tests run npm's template-oss check, which fails when a tracked file is ignored.\n  So allow ${files.length > 1 ? 'them' : 'it'} in the repo's own settings first: in package.json, under "templateOSS", add ${files.map((f) => `"/${f}"`).join(' and ')} to "allowPaths", then run: npx template-oss-apply --force\n  That rewrites .gitignore, so commit it and package.json too.\n`
  : `  This repo's ignore rules hide ${files.join(' and ')} from git, so add ${files.length > 1 ? 'them' : 'it'} by name: git add -f ${files.join(' ')}\n`);
const run = (args, cwd, stdio = ['ignore', 'pipe', 'pipe']) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio });

// TRY IT ON YOUR OWN PAST. Each of the last n commits (merges left out, first parents) is put to the engine with the
// contract a real run would write: its protected paths, and the counts it keeps beside the tests. The test run itself
// is not replayed: it is slow, and on 340 real commits every one of the 82 that were sent back was sent back for a
// protected path or a count (proof-bench/contract-replay). Read-only: the engine measures in throwaway copies. The
// reading of each commit is lookback.mjs, shared with `sawbuck align`.
async function tryIt(repo, cfg, n) {
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let lines = []; try { lines = git('log', '--no-show-signature', '--no-merges', '--first-parent', '-n', String(n), '--date=short', '--format=%H%x09%P%x09%ad%x09%s').split('\n').filter(Boolean); } catch {}
  const commits = lines.map((l) => { const [sha, parents, day, ...s] = l.split('\t'); return { sha, parent: (parents || '').split(' ')[0], day, subject: s.join(' ') }; }).filter((c) => c.parent);
  const { back, unread, signed } = await readCommits(repo, cfg, commits);
  const P = back.filter((b) => b.paths.length).length, W = back.filter((b) => b.worse.length).length;
  const tally = (list) => { const t = new Map(); for (const x of list) t.set(x, (t.get(x) || 0) + 1); return [...t].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '); };
  const o = [`sawbuck contract --try: nothing was written. Your last ${commits.length} commit${commits.length === 1 ? '' : 's'}, held against the contract a real run would write:`];
  o.push(`  ${commits.length - back.length - unread - signed} would have passed.`);
  if (signed) o.push(`  ${signed} is the commit that signed the contract (a rule does not apply to the change that adds it).`);
  if (back.length) {
    o.push(`  ${back.length} would have been sent back to ask you:`);
    if (P) o.push(`    ${P} touch${P === 1 ? 'es' : ''} a protected path (${tally(back.flatMap((b) => b.paths.flatMap((p) => p.files.length ? p.files : [p.name])))})`);
    if (W) o.push(`    ${W} make${W === 1 ? 's' : ''} a count worse (${tally(back.flatMap((b) => b.worse))})`);
    o.push('  They are:');
    for (const b of back.slice(0, 10)) o.push(`    ${b.sha.slice(0, 8)}  ${b.day}  ${b.subject.slice(0, 60)}  [${[...b.paths.flatMap((p) => p.files.length ? p.files : [p.name]), ...b.worse].slice(0, 3).join(', ')}]`);
    if (back.length > 10) o.push(`    and ${back.length - 10} more`);
  }
  if (unread) o.push(`  ${unread} could not be read.`);
  o.push('  Not replayed: the test run itself. A change to a workflow or to a count takes your reason: sawbuck check --allow "<why>".');
  process.stdout.write(o.join('\n') + '\n');
}

// the preset as the engine writes it, in a scratch repo, so the contract and the engine cannot drift apart
// realpathSync: a Mac's temp folder is reached through a symlink, and a script started by a path through one does not
// know itself as the main script (the engine's lock.mjs then writes nothing, and the dry run left the lock off its list)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sawbuck-contract-')));
try {
  execFileSync('git', ['init', '-q'], { cwd: scratch, stdio: 'ignore' });
  writeFileSync(join(scratch, 'package.json'), '{"name":"scratch"}\n');
  run([PW, 'init', '--preset', 'supply-chain', '--no-agent-block'], scratch);
  const preset = JSON.parse(readFileSync(join(scratch, 'promptwheel.config.json'), 'utf8'));
  const had = existsSync(cfgPath);
  // without --full, the paths that exist only for the lock and the scanners do not apply
  const mandates = preset.mandates.filter((m) => full || !JSON.stringify(m.paths || []).match(/packs|promptwheel\.lock/));
  // what both the dry run and the real run report: every protected path in the contract after signing, and the
  // supply-chain guards --full puts beside your own tests
  const names = (l) => new Set((l || []).map((x) => x && x.name));
  const counts = (c) => `${new Set([...names(c.mandates), ...names(mandates)]).size} protected paths${full ? `, ${preset.metrics.length} supply-chain guards` : ''}`;
  if (dry) {
    // The preview is the real run, done in a throwaway copy of what signing reads, so the two cannot drift apart:
    // the files in the repo's top folder, an existing workflow, the scanners, the remote and the exclude file.
    const shadow = realpathSync(mkdtempSync(join(tmpdir(), 'sawbuck-preview-')));
    try {
      // the preview's commit is Sawbuck's own, in a throwaway copy: it asks nothing of the person's gpg (commit.gpgsign,
      // where a key that wants a passphrase has no terminal to ask at) and runs none of their git hooks
      const g = (...a) => execFileSync('git', ['-c', 'user.name=sawbuck', '-c', 'user.email=sawbuck@local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: shadow, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      g('init', '-q');
      // .git is a FILE in a linked git worktree (and in a submodule): copied, it lands on the preview's own .git folder and the copy throws
      for (const e of readdirSync(repo, { withFileTypes: true })) if (e.isFile() && e.name !== '.git' && statSync(join(repo, e.name)).size < 32 * 1024 * 1024) cpSync(join(repo, e.name), join(shadow, e.name));
      for (const rel of [join('.github', 'workflows', 'sawbuck.yml'), join('.promptwheel', 'packs')]) if (existsSync(join(repo, rel))) cpSync(join(repo, rel), join(shadow, rel), { recursive: true });
      if (existsSync(join(repo, 'node_modules'))) { try { symlinkSync(join(repo, 'node_modules'), join(shadow, 'node_modules')); } catch { /* the lint check may not be offered in the preview */ } }
      const exclude = (root) => resolve(root, execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim());
      let remote = ''; try { remote = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
      if (remote) g('remote', 'add', 'origin', remote);
      try { if (existsSync(exclude(repo))) { mkdirSync(dirname(exclude(shadow)), { recursive: true }); cpSync(exclude(repo), exclude(shadow)); } } catch {}
      const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
      const exWas = read(exclude(shadow));
      g('add', '-A', '-f'); g('commit', '-q', '--allow-empty', '-m', 'as it is now');   // -f: a file the repo tracks in spite of its ignore rules is tracked here too
      run([fileURLToPath(import.meta.url), shadow, ...process.argv.slice(3).filter((a) => a !== '--dry-run' && !/^--try(=\d{1,3})?$/.test(a))], shadow);
      const rows = new Map();
      for (const l of g('status', '--porcelain', '-uall').split('\n').filter(Boolean)) {
        const f = l.slice(3).replace(/^(\.promptwheel\/packs\/supply-chain\/).*/, '$1');
        if (f !== 'node_modules') rows.set(f, l.startsWith('??') ? 'new' : 'changed');
      }
      const hid = hiddenFromGit(shadow);
      for (const f of hid) rows.set(f, 'new');
      const after = existsSync(join(shadow, 'promptwheel.config.json')) ? JSON.parse(read(join(shadow, 'promptwheel.config.json'))) : { metrics: [], mandates: [] };
      let now = {}; try { if (had) now = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch {}
      const notes = strict ? (now.metrics || []).filter((m) => m && m.report && REPORT.has(m.name)).length : 0;
      const what = {
        'promptwheel.config.json': `${counts(now)}, ${(after.metrics || []).length} checks in all (${(after.metrics || []).map((m) => m.name).join(', ')})${notes ? `, and ${notes} guards that are notes would block` : ''}${strict && now.testRewrites !== 'ask' ? `, and ${REWRITES.replace('now waits', 'would wait')}` : ''}`,
        'AGENTS.md': 'the written rule', 'CLAUDE.md': 'the written rule', '.cursorrules': 'the written rule',
        '.github/workflows/sawbuck.yml': commentOnly ? 'a CI check on pull requests, comment only: it fails none' : 'a CI check on pull requests',
        'promptwheel.lock.json': 'the shape of this repo',
        '.promptwheel/packs/supply-chain/': 'the two scanners the supply-chain guards run',
        '.gitignore': 'so the scanners reach git',
      };
      if (tryN) await tryIt(repo, after, tryN);
      else if (!rows.size) process.stdout.write('sawbuck contract --dry-run: already signed, nothing would change.\n');
      else {
        process.stdout.write('sawbuck contract --dry-run: nothing was written. A real run would write:\n');
        for (const [f, how] of rows) process.stdout.write(`  ${f.padEnd(34)} ${how}${what[f] ? ': ' + what[f] : ''}\n`);
        if (read(exclude(shadow)) !== exWas) process.stdout.write('  and lines in .git/info/exclude that keep Sawbuck\'s record out of git status (local, never committed)\n');
        if (hid.length) process.stdout.write(addByName(hid, repo));
      }
    } finally { rmSync(shadow, { recursive: true, force: true }); }
  } else {
    if (!had) run([join(HERE, 'init.mjs'), '-y', '--no-investigate'], repo);
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : { repeat: 1, metrics: [] };
    const before = { m: (cfg.mandates || []).length, g: (cfg.metrics || []).length };
    const hasM = names(cfg.mandates), hasG = names(cfg.metrics);
    cfg.mandates = [...(cfg.mandates || []), ...mandates.filter((m) => !hasM.has(m.name))];
    if (full) {
      cfg.metrics = [...(cfg.metrics || []), ...preset.metrics.filter((m) => !hasG.has(m.name)).map((m) => (!strict && REPORT.has(m.name) ? { ...m, report: true } : m))];
      cfg.evaluatorPaths = [...new Set([...(cfg.evaluatorPaths || []), ...(preset.evaluatorPaths || [])])];
    }
    // --strict on a repo signed with --full: the guards that were notes now block, as the --full output promised
    let hardened = 0;
    if (strict) for (const m of cfg.metrics || []) if (m && m.report && REPORT.has(m.name)) { delete m.report; hardened++; }
    // --strict also asks for a person's reason where a later commit of a pull request rewrote a test the base had, after an
    // earlier commit changed the source (the engine's "testRewrites": "ask"; a note in a plain contract). His decision of
    // 2026-11-24 (proof-bench/ship-vs-check). Kept once set: nothing here takes it out, as with the guards above.
    const askedRewrites = strict && cfg.testRewrites !== 'ask';
    if (askedRewrites) cfg.testRewrites = 'ask';
    const rewritesLine = askedRewrites ? `  ${REWRITES[0].toUpperCase()}${REWRITES.slice(1)}.\n` : '';
    // a repo signed with --say-why keeps that strength when it is signed again with no switch
    const saidWhy = had && cfg.allowTrailer !== false && (cfg.metrics || []).some((m) => m && TESTS3.includes(m.name) && m.allowable === true);
    const saysWhy = sayWhy || saidWhy;
    // --say-why typed in a repo already signed changes the contract: it is said, never "nothing changed" (seen after the wave of 0.2.1)
    const turnedOn = had && sayWhy && !saidWhy;
    if (saysWhy) { for (const m of cfg.metrics || []) if (m && TESTS3.includes(m.name) && m.allowable) m.allowable = true; delete cfg.allowTrailer; } else cfg.allowTrailer = false;
    // --solo: the opener's own comment counts on a pull request. Kept once set; said when a signed repo gets it now.
    const soloOn = solo && cfg.allowFromAuthor !== true, soloNow = had && soloOn;
    if (solo) cfg.allowFromAuthor = true;
    // the scripts the test command runs, judged with the tests (scriptsRun); a path an existing glob covers is left as it is
    const pkgTest = (() => { try { const sc = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts; return sc && typeof sc.test === 'string' ? sc.test : ''; } catch { return ''; } })();
    const covered = (f) => (cfg.evaluatorPaths || []).some((g) => { try { return globToRe(String(g)).test(f); } catch { return g === f; } });
    const ranNew = scriptsRun(repo, [...(cfg.metrics || []).filter((m) => m && m.guard === true && typeof m.cmd === 'string').map((m) => m.cmd), pkgTest]).filter((f) => !covered(f));
    if (ranNew.length) cfg.evaluatorPaths = [...(cfg.evaluatorPaths || []), ...ranNew];
    const ranSaid = ranNew.length ? `the test command runs ${ranNew.join(', ')}, so ${ranNew.length > 1 ? 'they are' : 'it is'} judged with the tests (evaluatorPaths): a change that cuts ${ranNew.length > 1 ? 'one' : 'it'} short reads gamed` : '';
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const pack = join(repo, '.promptwheel', 'packs', 'supply-chain');
    if (full) {
      mkdirSync(pack, { recursive: true });
      cpSync(join(scratch, '.promptwheel', 'packs', 'supply-chain'), pack, { recursive: true, filter: (f) => !/(README\.md|pack\.json)$/.test(f) });
      // the gate measures in clean worktrees, so the scanners must reach git. A repo attached earlier, or one that
      // ignores .promptwheel/ for the outcome record, would hide them and every guard would read unmeasurable.
      for (const f of [join(repo, '.gitignore'), resolve(repo, execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim())]) {
        if (!existsSync(f)) continue;
        const text = readFileSync(f, 'utf8');
        const next = text.replace(/^\.promptwheel\/?[ \t]*$/gm, '.promptwheel/*\n!.promptwheel/packs/');
        if (next !== text) writeFileSync(f, next);
      }
    }
    ensureExcluded(repo);
    // the written rule is what changes the agent (the pressure bench: 11 of 20 to 0 of 20), so every signing writes it
    writeAgentBlock(repo);
    // CI goes in here, before the rules take hold: afterwards the contract itself would refuse an agent the file.
    // For a GitHub repo. Where no test command was found the contract holds a placeholder: the check then runs no
    // tests and still reads the counts and the protected paths (the workflow passes `inconclusive: pass`, so a plain
    // change passes with no comment; proof-bench/live/release-0.2.3, t1.py). Until 0.2.2 no workflow was written there
    // at all, in 6 of 12 real repos, and the reason printed was not true. From 0.2.3 comment-only mode writes it, since
    // nothing fails in that mode. Without that switch it is still not written: a check that can fail a pull request
    // and runs no tests is for the person to turn on, not for a default.
    const wf = join(repo, '.github', 'workflows', 'sawbuck.yml');
    let remote = ''; try { remote = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
    const realTests = !(cfg.metrics || []).some((m) => /set your test command/.test(String(m.cmd)));
    let ci = '';
    if (full && /github\.com/.test(remote) && (realTests || commentOnly) && !existsSync(wf)) { mkdirSync(dirname(wf), { recursive: true }); writeFileSync(wf, workflow(existsSync(join(repo, 'package-lock.json')))); ci = wf; }
    const locked = existsSync(join(repo, 'promptwheel.lock.json'));
    if (full && !locked) run([join(pack, 'lock.mjs'), 'write', repo], repo);
    const added = (cfg.mandates.length - before.m) + (cfg.metrics.length - before.g);
    const fresh = added || hardened || ci || (full && !locked);
    // what a switch changed in a contract that was already signed, in words: never "nothing changed" over an edit
    const changed = [...(turnedOn ? ['the counts of the tests now take a reason written in a commit'] : []), ...(soloNow ? ['on a pull request your own comment now counts ("allowFromAuthor": true)'] : []), ...(askedRewrites ? [REWRITES] : []), ...(ranSaid ? [ranSaid] : [])];
    process.stdout.write(!fresh ? (changed.length ? `sawbuck: already signed. ${changed.length > 1 ? 'Two things' : 'One thing'} changed in promptwheel.config.json: ${changed.join('; ')}.\n  The contract is a protected path, so the commit that carries this needs a person's reason: ${cli('check --allow "<reason>"')}.\n${soloNow ? '  Commit it on your default branch: a pull request cannot turn this on for itself.\n' : ''}` : 'sawbuck: already signed, nothing changed.\n') : full
      ? `sawbuck: signed. ${counts(cfg)}, and the shape of this repo in promptwheel.lock.json.\n${strict ? (hardened ? `  ${hardened} guards that were notes now block. The contract is a protected path, so the commit that carries this needs a person's reason: ${cli('check --allow "<reason>"')}.\n` : '') + rewritesLine : '  New dependencies and structure changes show as notes for now; protected paths and install scripts block. --strict blocks them all.\n'}${ci ? `  Added .github/workflows/sawbuck.yml, so pull requests are checked in CI. Commit it with the rest.\n${commentOnly ? '  It is comment only (--comment-only): no pull request fails, and the comment says what would have been sent back.\n  To make it count, take "comment-only: true" out of the workflow\'s last line. That is a workflow change, so it takes a person\'s reason.\n' : ''}${solo ? '' : `  On a pull request, a change that takes a reason is let through by a comment from someone with write access who did not open it: sawbuck-allow: <reason>. If you are the only person here, sign with --solo so your own comment counts: ${cli('contract --solo')}\n`}` : ''}`
      : `sawbuck: signed. ${counts(cfg)}, and the rule in AGENTS.md.\n  --full adds supply-chain guards, a repo lock and a CI check.\n${rewritesLine}`);
    if (fresh && ranSaid) process.stdout.write(`  ${ranSaid[0].toUpperCase()}${ranSaid.slice(1)}.\n`);
    // a placeholder that always fails is never only "signed" (row 17, from wavecutter: the plain path said nothing of it)
    if (!realTests) process.stdout.write('  No test command was found here, so the check runs no tests yet. It still reads the counts of your tests and the protected paths.\n  To have your tests run, put your test command in promptwheel.config.json where the placeholder is.\n');
    if ((fresh && sayWhy) || turnedOn) process.stdout.write('  A test may be removed where a commit of the change says why: end its message with\n    Sawbuck-Allow: test_count: <what was removed, and who asked for it>\n  The reason is kept on the record. A protected path still takes a person.\n');
    if ((fresh && solo) || soloNow) process.stdout.write('  One person works here (--solo), so on a pull request your own comment counts: sawbuck-allow: <reason>\n  GitHub cannot tell you from your agent there: the agent works under your account. What is kept is the reason, not proof of who gave it.\n');
    // --comment-only with nothing to write it into: say what to do, and never write over a workflow that is here
    if (commentOnly && !ci) {
      let has = ''; try { has = readFileSync(wf, 'utf8'); } catch { /* no workflow here */ }
      if (!has && !full) process.stdout.write(`  --comment-only is about the pull request check, and --full is what writes it: ${cli('contract --full --comment-only')}\n`);
      else if (has && !/comment-only:\s*['"]?true/.test(has)) process.stdout.write(`  .github/workflows/sawbuck.yml is already here, and Sawbuck never rewrites a workflow file. To make it comment only, change its last line yourself to:\n    ${WITH}\n  That is a workflow change, so it takes a person's reason. It needs the engine at v0.8.15 or newer in the "uses:" line above it.\n`);
    }
    if (full && !ci && !existsSync(wf)) process.stdout.write(!/github\.com/.test(remote)
      ? '  No CI check added: this repo has no github.com origin. Run sawbuck contract --full again once it has one.\n'
      : `  No CI check added: no test command was found here. Put yours in promptwheel.config.json where the placeholder is, then run ${cli('contract --full')} again.\n  To try the check on pull requests before that, run ${cli('contract --full --comment-only')}: it runs no tests, reads the counts of your tests and the protected paths, and fails no pull request.\n`);
    const old = ci ? '' : olderCi(wf);
    // The line is a workflow change. A contract written from 0.1.70 on lets one through with a person's reason. A contract
    // written before it holds its own copy of the rule with no way through (proof-bench/pr-shapes: a pull request with
    // only this line is sent back, with or without a comment), so the words carry the way through too. A claim walks both.
    const hard = (cfg.mandates || []).some((m) => m && m.name === 'workflows-frozen' && !m.allowable);
    if (old) process.stdout.write(`  .github/workflows/sawbuck.yml runs an older engine (${old}); this sawbuck pins v${PKG.dependencies.promptwheel}. Sawbuck never rewrites a workflow file: it is a protected path, and yours. For the newer check on pull requests, change its line to:\n    uses: ${ACTION}\n  Change it yourself: at the end of a turn an agent's own change to a protected path is sent back, with a reason or without.\n${hard ? '  The "workflows-frozen" rule here takes no reason (contracts written before 0.1.70 do not), so the change is sent back as it stands. It takes two changes, each with a person\'s reason: first add "allowable": "flag" to the "workflows-frozen" rule in promptwheel.config.json, as new contracts have it; then change the line.\n' : '  That is a workflow change, so it takes a person\'s reason: ' + cli('check --allow "<reason>"') + ', or on a pull request a comment from someone who did not open it.\n'}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// a suggestion, not a rule: only a person should freeze product code
let files = [];
try { files = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0'); } catch { /* not a repo: attach says so */ }
const seen = new Set();
for (const f of files) { const m = f.match(/^(.*?(?:^|\/)(?:auth|authentication|billing|payments?|migrations))\//); if (m && !/(^|\/)(node_modules|test|tests|docs?|examples?|samples?|demos?|fixtures?)\//.test(m[1])) seen.add(m[1]); }
if (seen.size) process.stdout.write(`\n  To protect product code too, add these protected paths under "mandates" in promptwheel.config.json:\n${[...seen].slice(0, 5).map((d) => `    { "name": "${d.replace(/\W+/g, '-')}", "paths": ["${d}/**"], "reason": "changed by a person" }`).join('\n')}\n`);
if (!dry) {
  const hid = hiddenFromGit(repo);
  process.stdout.write(hid.length
    ? `\n${addByName(hid, repo)}  Commit ${hid.length > 1 ? 'them' : 'it'}${full ? ' with the rest of what signing wrote' : ''}. Then sawbuck attach watches every turn: protected paths at turn end, each commit re-proved.\n`
    : `\n  Commit promptwheel.config.json and AGENTS.md${full ? ', promptwheel.lock.json and .promptwheel/packs/' : ''}. Then sawbuck attach watches every turn: protected paths at turn end, each commit re-proved.\n`);
}
