// CLI + ranker behavior tests (node:test). Run: npm test (or node --test).
// Covers the glue built this session: attach/detach wiring, the isolation
// invariant (attach leaves the worktree clean; detach is a true inverse),
// trace/verify/dry-run, rank's per-path filtering, and context.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'sawbuck.mjs');
// isolate HOME so the global registry (~/.sawbuck) never touches the real home.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'sawbuck-home-'));
after(() => rmSync(TMP_HOME, { recursive: true, force: true }));
const sawbuck = (args, cwd, env) => execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: TMP_HOME, ...env } });
const porcelain = (d) => execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' }).trim();

function tmpRepo() {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-cli-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'a.js'), 'export const v = 1;\n'); g('add', '-A'); g('commit', '-qm', 'init');
  return { d, g };
}

test('attach wires an idempotent git post-commit hook; detach is a true inverse', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['attach', '.'], d);
    const pc = join(d, '.git', 'hooks', 'post-commit');
    assert.ok(existsSync(pc), 'post-commit created');
    assert.match(readFileSync(pc, 'utf8'), /# >>> sawbuck >>>/);
    assert.match(sawbuck(['attach', '.'], d), /already attached/);       // idempotent
    sawbuck(['detach', '.'], d);
    assert.ok(!existsSync(pc), 'post-commit we created is removed, not left as a stub');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

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
    assert.throws(() => sawbuck(['init', '--yes'], d), 'refuses to clobber an existing contract without --force');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('event feed: the check logs every result (gamed + verified) and sawbuck log reads it', () => {
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
    try { sawbuck(['check'], d); } catch {}
    // VERIFIED: fix the source, restore the honest test
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a - b;\n');
    writeFileSync(join(d, 'calc.test.mjs'), honestTest);
    g('commit', '-qam', 'fix sub in source');
    try { sawbuck(['check'], d); } catch {}
    const feed = readFileSync(join(d, '.sawbuck', 'activity.jsonl'), 'utf8');
    assert.match(feed, /"kind":"gamed"/, 'the gamed check was logged');
    assert.match(feed, /"kind":"verified"/, 'the verified check was logged too (not only catches)');
    const log = sawbuck(['log'], d);
    assert.match(log, /sawbuck activity/);
    assert.match(log, /verified/);
    assert.match(log, /gamed/);
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

test('attach preserves a pre-existing post-commit hook and detach restores it', () => {
  const { d } = tmpRepo();
  const pc = join(d, '.git', 'hooks', 'post-commit');
  try {
    writeFileSync(pc, '#!/bin/sh\necho mine\n');
    sawbuck(['attach', '.'], d);
    assert.match(readFileSync(pc, 'utf8'), /echo mine/, 'our block is appended, theirs kept');
    sawbuck(['detach', '.'], d);
    assert.ok(existsSync(pc), 'their hook is NOT deleted (we did not create it)');
    assert.equal(readFileSync(pc, 'utf8').replace(/\n+$/, '\n'), '#!/bin/sh\necho mine\n', 'restored to theirs');
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

test('trace shows the footprint, and reports clean after detach', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['attach', '.'], d);
    assert.match(sawbuck(['trace', '.'], d), /post-commit/);
    sawbuck(['detach', '.'], d);
    assert.match(sawbuck(['trace', '.'], d), /no footprint/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('statusline prints a compact guide segment', () => {
  const { d } = tmpRepo();
  try {
    assert.match(sawbuck(['statusline'], d), /🐴 sawbuck · watching/);
    mkdirSync(join(d, '.sawbuck'), { recursive: true });
    writeFileSync(join(d, '.sawbuck', 'results.json'), JSON.stringify({ regressions: 1, gamed: 1 }));
    assert.match(sawbuck(['statusline'], d), /🐴 sawbuck · 2 caught/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach refuses a non-git directory', () => {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-nogit-'));
  try { assert.throws(() => sawbuck(['attach', '.'], d)); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test('git post-commit hook records a catch through a REAL commit (GIT_DIR inheritance regression)', () => {
  const { d, g } = tmpRepo();
  try {
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, repeat: 1, metrics: [{ name: 'tests_pass', cmd: 'node --test calc.test.mjs 2>&1', extract: 'exit', direction: 'pass', guard: true }] }));
    writeFileSync(join(d, 'calc.mjs'), 'export const sub = (a, b) => a + b; // BUG\n');
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),2));\n");
    g('add', '-A'); g('commit', '-q', '-m', 'base (red)');
    sawbuck(['attach', '.'], d);
    sawbuck(['__hook', '--repo', d], d);   // arm the reflex on the base commit
    // the cheat: edit the TEST to expect the buggy value, landed via a REAL git commit so the
    // post-commit hook fires with git's own GIT_DIR/GIT_INDEX_FILE exported (the bug's trigger).
    writeFileSync(join(d, 'calc.test.mjs'), "import {test} from 'node:test';import assert from 'node:assert';import {sub} from './calc.mjs';\ntest('sub',()=>assert.strictEqual(sub(5,3),8));\n");
    g('commit', '-q', '-am', 'fake the pass');
    const r = JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8'));
    assert.ok((r.gamed || 0) + (r.regressions || 0) >= 1, 'the post-commit hook caught the faked win through a real commit (the hook must clear inherited git env)');
  } finally { rmSync(d, { recursive: true, force: true }); }
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
    assert.match(JSON.stringify(cfg.hooks.UserPromptSubmit), /sawbuck\.mjs.*context/, 'context hook wired at user level');
    assert.doesNotMatch(JSON.stringify(cfg.hooks.Stop), /--repo/, 'cwd-based: no repo pinned');
    sawbuck(['detach', '--user', '.'], d, { HOME: home });
    assert.ok(!existsSync(f), 'user settings we created are removed (true inverse)');
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test('attach --claude writes gitignored settings.local.json and keeps git status clean', () => {
  const { d } = tmpRepo();
  const f = join(d, '.claude', 'settings.local.json');
  try {
    sawbuck(['attach', '--claude', '.'], d);
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.match(JSON.stringify(cfg.hooks.UserPromptSubmit), /context/, 'trail-guide (read) hook wired');
    assert.match(JSON.stringify(cfg.hooks.Stop), /__hook/, 'check (reflex) hook wired');
    assert.equal(porcelain(d), '', 'local settings are locally excluded → worktree still clean');
    sawbuck(['attach', '--claude', '.'], d);            // idempotent
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).hooks.UserPromptSubmit.length, 1, 'no duplicate on re-attach');
    sawbuck(['detach', '--claude', '.'], d);
    assert.ok(!existsSync(f), 'local settings we created are removed (true inverse)');
    assert.equal(porcelain(d), '', 'clean after detach');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('attach --claude --shared writes the tracked settings.json (visible in git by design)', () => {
  const { d } = tmpRepo();
  const f = join(d, '.claude', 'settings.json');
  try {
    sawbuck(['attach', '--claude', '--shared', '.'], d);
    assert.ok(existsSync(f), 'wrote the shared, tracked settings.json');
    assert.match(porcelain(d), /\.claude/, 'shared settings intentionally show up in git');
    sawbuck(['detach', '--claude', '.'], d);
    assert.ok(!existsSync(f), 'removed');
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

test('run drives an attempt through the keep-if-verified gate (dummy agent)', () => {
  const d = mkdtempSync(join(tmpdir(), 'sawbuck-run-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  try {
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(d, '.gitignore'), '.promptwheel/\n.sawbuck/\n');
    writeFileSync(join(d, 'promptwheel.config.json'), JSON.stringify({ linkNodeModules: false, metrics: [{ name: 'todos', cmd: 'grep -c TODO app.js || true', extract: 'number', direction: 'down', guard: true }] }));
    writeFileSync(join(d, 'app.js'), 'a // TODO\nb // TODO\nc // TODO\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    // dummy "agent": removes one TODO -> metric improves -> the gate keeps it
    const o = sawbuck(['run', '--attempt', "sed -i '0,/ \\/\\/ TODO/s///' app.js", '--loops', '1'], d, { LOGBOOK_NO_CACHE: '1' });
    assert.match(o, /-> kept/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('where lists an attached repo and drops it after detach', () => {
  const { d } = tmpRepo();
  try {
    sawbuck(['attach', '.'], d);
    assert.ok(sawbuck(['where'], d).includes(d), 'where lists the attached repo');
    sawbuck(['detach', '.'], d);
    assert.ok(!sawbuck(['where'], d).includes(d), 'where no longer lists it after detach');
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
    sawbuck(['check', '--base', 'HEAD~1', '--head', 'HEAD'], d, { LOGBOOK_NO_CACHE: '1' });
    let r = {}; try { r = JSON.parse(readFileSync(join(d, '.sawbuck', 'results.json'), 'utf8')); } catch { /* no file = no catch */ }
    assert.equal((r.gamed || 0) + (r.regressions || 0), 0, 'a red->green fix earned in source is never charted as a catch');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
