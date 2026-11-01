#!/usr/bin/env node
// run.mjs, the thin reference harness. Each loop: load context, run ONE attempt
// through the keep-if-verified gate, repeat. It loops primitives that already
// exist (sawbuck context + promptwheel improve + YOUR agent); it is NOT an
// orchestrator (no planning, routing, or queue, that is the platform's job).
// Usage:  node run.mjs --attempt '<agent cmd>' [--loops N] [--repo P]
//   the attempt cmd can read $SAWBUCK_CONTEXT (a file of the ranked relevant history).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bin = (envVar, pkg, dev) => { if (process.env[envVar]) return process.env[envVar]; const bare = pkg.replace(/\/bin\/[^/]*$/, ''); for (const s of [pkg, bare]) { try { return require.resolve(s); } catch {} } return dev; };
const PW = bin('PW_BIN', 'promptwheel/bin/promptwheel.mjs', join(HERE, '..', 'promptwheel', 'bin', 'promptwheel.mjs'));

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const repo = arg('--repo', process.cwd());
const attempt = arg('--attempt', null);
const loops = Math.max(1, parseInt(arg('--loops', '1'), 10) || 1);
if (!attempt) { process.stderr.write("sawbuck run: --attempt '<agent cmd>' is required\n"); process.exit(2); }

const context = () => { try { return execFileSync(process.execPath, [join(HERE, 'sawbuck.mjs'), 'context', repo], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return (e.stdout || '').toString(); } };
const parseResult = (s) => { try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)).result || 'error'; } catch { return 'error'; } };

const scratch = mkdtempSync(join(tmpdir(), 'sawbuck-run-'));
let kept = 0;
try {
  for (let i = 1; i <= loops; i++) {
    const ctxFile = join(scratch, `context-${i}.md`);
    writeFileSync(ctxFile, context() || 'no prior findings yet.\n');   // load the trajectory
    let result;
    try {
      const out = execFileSync(process.execPath, [PW, 'improve', '--attempt', attempt, '--json'],
        { cwd: repo, encoding: 'utf8', env: { ...process.env, SAWBUCK_CONTEXT: ctxFile, PW_PLAYBOOK: ctxFile }, timeout: 600000, stdio: ['ignore', 'pipe', 'ignore'] });
      result = parseResult(out);
    } catch (e) { result = parseResult((e.stdout || '').toString()); }
    if (result === 'kept') kept++;
    process.stdout.write(`sawbuck run: loop ${i}/${loops} -> ${result}\n`);
    if (result === 'plateau' || result === 'error') break;   // nothing left to improve, or it broke
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
process.stdout.write(`sawbuck run: ${kept} verified improvement${kept === 1 ? '' : 's'} kept\n`);
