// align.test.mjs   sawbuck align (Sawbuck joining work already under way, said once to the person and once to the agent)
// and no dead ends (where it would stop for no repository, it offers to start one). The plan, written before any of
// this: ~/IdeaProjects/align-plan-2026-11-22.md. Run: npm test (or node --test).
import { TMP_HOME } from '../testkit.mjs';   // first: a throwaway HOME and temp folder for everything this file starts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'sawbuck.mjs');
const ENV = { ...process.env, HOME: TMP_HOME, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const sb = (args, cwd, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...ENV, ...env }, input: '' });
const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', env: ENV }).trim();
const put = (d, f, t) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), t); };
const at = (iso) => ({ GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
const commit = (d, msg, when) => execFileSync('git', ['-C', d, 'commit', '-qam', msg], { env: { ...ENV, ...(when ? at(when) : {}) } });
const TWO = "const assert = require('node:assert');\nconst { test } = require('node:test');\ntest('f', () => { assert.equal(require('../src/a.js').f(), 1); });\ntest('g', () => { assert.ok(true); });\n";
const ONE = "const assert = require('node:assert');\nconst { test } = require('node:test');\ntest('f', () => { assert.equal(require('../src/a.js').f(), 3); });\n";

// work under way before Sawbuck: an honest commit, then (late) one that takes a test out to fit changed source
function project({ late = true, dates = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'align-'));
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'commit.gpgsign', 'false');
  put(d, 'package.json', '{"name":"r","scripts":{"test":"node --test"}}\n'); put(d, 'src/a.js', 'exports.f = () => 1;\n'); put(d, 'test/a.test.js', TWO);
  git(d, 'add', '-A'); commit(d, 'the project begins', dates && '2026-01-01T10:00:00Z');
  put(d, 'src/a.js', 'exports.f = () => 1;\nexports.g = () => 2;\n'); commit(d, 'add g', dates && '2026-01-01T11:00:00Z');
  if (late) { put(d, 'src/a.js', 'exports.f = () => 3;\nexports.g = () => 2;\n'); put(d, 'test/a.test.js', ONE); commit(d, 'make the tests pass', dates && '2026-01-01T12:00:00Z'); }
  return git(d, 'rev-parse', '--show-toplevel');
}
const sign = (d, when) => { const r = sb(['contract'], d); assert.equal(r.status, 0, r.stderr); git(d, 'add', '-A'); execFileSync('git', ['-C', d, 'commit', '-qm', 'sawbuck contract'], { env: { ...ENV, ...(when ? at(when) : {}) } }); };

test('align: a commit that took a test out before Sawbuck joined is named, with the counts it lowered, and nothing is sent back', () => {
  const d = project(); sign(d);
  const r = sb(['align'], d);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"make the tests pass": .*the test count fell from 2 to 1/);
  assert.match(r.stdout, /"make the tests pass": .*the assertions fell from 4 to 3/);   // the engine's own count of that file
  assert.match(r.stdout, /A reading, not a verdict: nothing from before is sent back/);
  assert.doesNotMatch(r.stdout, /"add g"/, 'an honest commit is not named');
});

test('align: honest work reads as nothing of note', () => {
  const d = project({ late: false }); sign(d);
  const r = sb(['align'], d);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Nothing of note/);
});

test('silent on a pass: joining honest work takes two lines at attach, and the agent is handed nothing', () => {
  const d = project({ late: false }); sign(d);
  const a = sb(['attach'], d);
  assert.equal(a.status, 0, a.stderr);
  const said = a.stdout.slice(a.stdout.indexOf('sawbuck align:')).trim().split('\n');
  assert.equal(said.length, 3, `the heading, what was read, and "nothing of note": ${JSON.stringify(said)}`); assert.match(said[2], /Nothing of note/);
  const up = JSON.parse(readFileSync(join(d, '.claude', 'settings.local.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  const first = spawnSync('sh', ['-c', up], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go', cwd: d }) }).stdout;
  assert.doesNotMatch(first, /align \(sawbuck\)/, 'nothing about the earlier work is added to the context');
  const guard = JSON.parse(readFileSync(join(d, '.git', 'sawbuck', 'guard.json'), 'utf8'));
  assert.equal(guard.align.agent, null); assert.match(guard.align.delivered, /nothing of note/);
});

test('attach --user is not this repo joining: it reads no work and writes nothing into the repo', () => {
  const d = project(); sign(d);
  const home = mkdtempSync(join(tmpdir(), 'user-home-'));   // a home of its own: user-level hooks would reach every later test
  const a = sb(['attach', '--user'], d, { HOME: home });
  assert.equal(a.status, 0, a.stderr); assert.doesNotMatch(a.stdout, /sawbuck align:/);
  const g = join(d, '.git', 'sawbuck', 'guard.json');
  assert.ok(!existsSync(g) || !JSON.parse(readFileSync(g, 'utf8')).align, 'no reading was written down');
});

test('align --since reads from the commit named, and no further back', () => {
  const d = project(); sign(d);
  const r = sb(['align', '--since', 'HEAD~1'], d);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /the commit you named \(HEAD~1\)/); assert.doesNotMatch(r.stdout, /make the tests pass/);
  assert.equal(sb(['align', '--since', 'no-such-ref'], d).status, 64);
});

test('align reads from where this Claude Code session began, by the first time in its transcript and nothing else', () => {
  const d = project({ dates: true }); sign(d, '2026-01-01T12:30:00Z');
  // the session began at 11:30, after "add g" and before "make the tests pass". Its first line holds a time and this folder.
  const dir = join(TMP_HOME, '.claude', 'projects', d.replace(/\//g, '-')); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-01-01T11:30:00.000Z', cwd: d, sessionId: 's', message: { role: 'user', content: 'words that are never read' } }) + '\n');
  const r = sb(['align', '--json'], d);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.start.sha, git(d, 'rev-parse', 'HEAD~2'), 'read from "add g", the commit the session began at');
  assert.match(j.start.why, /where this Claude Code session began \(2026-01-01 11:30 UTC\)/);
  assert.equal(j.read, 2); assert.equal(j.back.length, 1); assert.equal(j.back[0].subject, 'make the tests pass');
  assert.doesNotMatch(r.stdout, /words that are never read/);
});

test('attach on a repo with work in it says the reading once, and the agent gets it once, at its next prompt', () => {
  const d = project(); sign(d);
  const a = sb(['attach'], d);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /sawbuck align: where the work stands/); assert.match(a.stdout, /make the tests pass/);
  const up = JSON.parse(readFileSync(join(d, '.claude', 'settings.local.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  const prompt = (p) => spawnSync('sh', ['-c', up], { cwd: d, encoding: 'utf8', env: ENV, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: p, cwd: d }) }).stdout;
  const first = prompt('go');
  assert.match(first, /▣ align \(sawbuck\)/); assert.match(first, /make the tests pass/); assert.match(first, /In your answer, tell the person about each line above and ask whether it was meant\./); assert.doesNotMatch(first, /before you go on/);
  assert.doesNotMatch(prompt('more'), /align \(sawbuck\)/, 'said once');
  assert.doesNotMatch(sb(['attach'], d).stdout, /sawbuck align:/, 'a second attach does not read again');
});

test('align: a protected path a commit changed is named as one only a person changes', () => {
  const d = project({ late: false }); sign(d);
  put(d, '.github/workflows/ci.yml', 'on: push\n'); git(d, 'add', '-A'); commit(d, 'a workflow');
  const r = sb(['align', '--since', 'HEAD~1'], d);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /"a workflow": it changed \.github\/workflows\/ci\.yml, which only a person changes/);
});

test('align with no contract says how to give one, exit 64', () => {
  const d = project();
  const r = sb(['align'], d);
  assert.equal(r.status, 64); assert.match(r.stderr, /Give it one first: sawbuck contract/);
});

test('no dead ends: outside a repository, contract, attach, check and align say how to start one, wait for nothing, and make nothing', () => {
  for (const cmd of ['contract', 'attach', 'check', 'align']) {
    const d = mkdtempSync(join(tmpdir(), 'norepo-'));
    const r = sb([cmd], d);
    assert.equal(r.status, 64, `${cmd}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /is not a git repository yet/); assert.match(r.stderr, /To start one: git init, then sawbuck/);
    assert.ok(!existsSync(join(d, '.git')), `${cmd} made no repository`);
  }
});

const term = spawnSync('script', ['-qec', 'true', '/dev/null'], { encoding: 'utf8' }).status === 0;
test('no dead ends, on a terminal: Enter starts a repository and goes on with the command; q stops and makes nothing', { skip: !term && 'no `script` here to give the command a terminal' }, () => {
  const onTerm = (d, keys) => spawnSync('script', ['-qec', `"${process.execPath}" "${CLI}" contract`, '/dev/null'], { cwd: d, input: keys, encoding: 'utf8', env: ENV, timeout: 60000 });
  const d = mkdtempSync(join(tmpdir(), 'start-')); put(d, 'package.json', '{"name":"r","scripts":{"test":"node --test"}}\n');
  const r = onTerm(d, '\n');
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /Press Enter to start one here/); assert.match(r.stdout, /Started a git repository/);
  assert.match(r.stdout, /Nothing of yours is committed/); assert.ok(existsSync(join(d, '.git'))); assert.ok(existsSync(join(d, 'promptwheel.config.json')), 'and the contract was written');
  assert.equal(git(d, 'rev-list', '--all').length, 0, 'nothing was committed');
  const e = mkdtempSync(join(tmpdir(), 'stop-'));
  const q = onTerm(e, 'q\n');
  assert.equal(q.status, 64, q.stdout); assert.match(q.stdout, /Nothing was done/); assert.ok(!existsSync(join(e, '.git')));
});
