// Behavior test for the Sawbuck glue (node:test). Run: npm test  (or: node --test)
//
// The whole M0 loop in one scenario, with the engines stubbed via PW_BIN / LB_BIN:
//   trip a bad commit -> the check says gamed -> reflect records it as a gamed
//   change in the results.
// Stubbing the check keeps this deterministic (no real metric run needed).

import '../testkit.mjs';   // first: a throwaway HOME and temp folder for everything this file starts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFLECT = join(HERE, '..', 'reflect.mjs');

// A repo with two commits; the second changes a source file (the finding target).
function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sawbuck-reflect-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'sawbuck-test');
  writeFileSync(join(dir, 'app.js'), 'export const v = 1;\n');
  git('add', '.'); git('commit', '-qm', 'init');
  writeFileSync(join(dir, 'app.js'), 'export const v = 2;\n');
  git('add', '.'); git('commit', '-qm', 'change app');
  // Stub engines (untracked -> absent from the diff reflect inspects).
  // The check engine keeps its own verdict vocabulary ('gamed'); Sawbuck surfaces the same word.
  const pw = join(dir, 'pw-stub.mjs');
  writeFileSync(pw, "console.log(JSON.stringify({verdict:'gamed',metrics:[{gamed:true,gamingReason:'tests were edited to pass'}]}));\n");
  const lb = join(dir, 'lb-stub.mjs');
  writeFileSync(lb, 'process.exit(0);\n');
  return { dir, env: { ...process.env, PW_BIN: pw, LB_BIN: lb } };
}

const runReflect = (dir, env) =>
  execFileSync(process.execPath, [REFLECT, '--repo', dir], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('reflect records a gamed result as a gamed change in the results', () => {
  const { dir, env } = setupRepo();
  try {
    runReflect(dir, env);
    const rec = JSON.parse(readFileSync(join(dir, '.sawbuck', 'results.json'), 'utf8'));
    assert.equal(rec.gamed, 1);
    assert.equal(rec.regressions, 0);
    assert.equal(rec.latest.kind, 'gamed');
    assert.equal(rec.latest.file, 'app.js');
    assert.match(rec.latest.reason, /gamed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The commit hook reads the engine's report through a pipe. A report that arrives cut (the engine was stopped while it
// printed; until engine 0.8.16 also any report larger than a pipe holds) is "no verdict": the reader ends quietly and
// records nothing. With a verdict's exit code it used to throw from inside its own catch, and wrote a stack.
test('reflect: a report that arrives cut is no verdict, never a crash', () => {
  const { dir, env } = setupRepo();
  try {
    for (const code of [0, 1, 2]) {
      writeFileSync(join(dir, 'pw-stub.mjs'), `process.stdout.write('{"verdict":"gamed","metrics":[{"gamed":true,"gamingReason":"tests were ed'); process.exitCode = ${code};\n`);
      const r = spawnSync(process.execPath, [REFLECT, '--repo', dir, '--answer'], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, `exit ${code} from the engine: reflect exited ${r.status} and wrote ${JSON.stringify(r.stderr.slice(0, 160))}`);
      assert.equal(r.stderr, '', `exit ${code} from the engine: nothing on standard error`);
      assert.equal(existsSync(join(dir, '.sawbuck', 'results.json')), false, 'nothing is recorded from a report nobody could read');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
