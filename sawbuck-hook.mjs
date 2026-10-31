#!/usr/bin/env node
// sawbuck-hook.mjs: the Sawbuck Claude Code Stop-hook entry (M0).
// Each turn: if a new commit landed, run reflect on it; then render the dispatch
// on a fresh catch OR every N turns (config). State in .sawbuck/state.json.
// Zero-dep. Usage (wired as a Stop hook): node sawbuck-hook.mjs --repo <path>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const flag = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const repo = flag('--repo', process.cwd());
ensureExcluded(repo);   // keep the record out of git status under ANY attach mode (incl. --user)

const git = (...a) => { try { return execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const CHECK_TIMEOUT = +(process.env.SAWBUCK_CHECK_TIMEOUT_MS) || 600000;   // never hang a turn
const node = (f, a) => { try { return execFileSync(process.execPath, [f, ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT, killSignal: 'SIGKILL' }); } catch (e) { return (e.stdout || '').toString(); } };

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(repo, 'sawbuck.config.json'), 'utf8')); } catch {}
const everyTurns = cfg.dispatch?.everyTurns ?? 5;
const onlyOnCatch = cfg.dispatch?.onlyOnCatch ?? false;

const stDir = join(repo, '.sawbuck');
const stPath = join(stDir, 'state.json');
let st = { lastSha: '', turns: 0, shownTotal: 0 };
try { if (existsSync(stPath)) st = JSON.parse(readFileSync(stPath, 'utf8')); } catch {}

// 1) new commit(s) since last turn → run the check on them
const head = git('rev-parse', 'HEAD');
if (head && st.lastSha && head !== st.lastSha) {
  node(join(HERE, 'reflect.mjs'), ['--repo', repo, '--base', st.lastSha, '--head', head]);
}
st.lastSha = head || st.lastSha;
st.turns += 1;

// 2) decide whether to speak, fresh catch always; cadence unless onlyOnCatch
let total = 0;
try { const r = JSON.parse(readFileSync(join(stDir, 'results.json'), 'utf8')); total = (r.regressions || 0) + (r.gamed || 0); } catch {}
const freshCatch = total > (st.shownTotal || 0);
const cadenceHit = everyTurns > 0 && st.turns % everyTurns === 0;
if (freshCatch || (cadenceHit && !onlyOnCatch)) {
  const out = node(join(HERE, 'dispatch.mjs'), ['--repo', repo]);
  if (out.trim()) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  st.shownTotal = total;
}

try { mkdirSync(stDir, { recursive: true }); writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n'); } catch {}

// Keep the record dirs out of `git status` via .git/info/exclude, so Sawbuck never
// dirties the worktree, including under `attach --user`, which is global and cannot
// set this up per-repo at attach time. Idempotent; markers match the CLI's so a
// per-repo `detach` removes them.
function ensureExcluded(r) {
  try {
    if (!existsSync(join(r, '.git'))) return;
    const f = join(r, '.git', 'info', 'exclude');
    // the record dirs + the logbook's root ledger cache (events.jsonl). Rewrite the block to
    // the CURRENT set rather than bail on presence, so a grown set retrofits existing repos.
    const WANT = '# >>> sawbuck >>>\n.sawbuck/\n.promptwheel/\nevents.jsonl\nannotations.jsonl\nannotation-reviews.jsonl\ndecision-cards.jsonl\nLOGBOOK.md\nJOURNEY.md\n# <<< sawbuck <<<\n';
    const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const stripped = body.replace(/# >>> sawbuck >>>[\s\S]*?# <<< sawbuck <<<\n?/g, '');
    const next = (stripped && !stripped.endsWith('\n') ? stripped + '\n' : stripped) + WANT;
    if (next === body) return;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, next);
  } catch {}
}
