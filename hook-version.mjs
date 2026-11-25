// Which version a set of hooks starts. Each hook command is run as the hook runs it, with --version in place of its
// arguments: the same node lookup, the same baked path, the same npx fallback. A hook never looks sawbuck up on PATH,
// so neither does this. On wavecutter the hooks started 0.2.2 from a checkout for two days while 0.2.7 was installed,
// and only `doctor` said anything (2026-11-24). Now `doctor`, `attach` and `status` say it. It starts a process for
// each command, so the statusline never calls it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OURS } from './repo-state.mjs';
import { older } from './copies.mjs';

// the version one hook command starts: '' where it does not run, does not say, or on Windows (not run there)
export function hookVersion(command) {
  if (process.platform === 'win32') return '';
  const probe = String(command).replace(/(sawbuck\.mjs"?|sawbuck@[\w.-]+) [^;]*/g, '$1 --version');
  try {
    const out = execFileSync('sh', ['-c', probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }).trim();
    const m = /^(\d+\.\d+\.\d+)/.exec(out); return m ? m[1] : '';
  } catch { return ''; }
}
// The version a hook command names, read without running it: an npx line pins it (`sawbuck@0.2.7`), a baked path has
// its package.json beside it. '' when neither says. status and attach use this one: running a hook to ask can reach
// the network (an npx line) and wait, and status must not. doctor runs the hook (hookVersion), as it always has.
export function hookVersionNamed(command) {
  const c = String(command);
  const pin = /sawbuck@(\d+\.\d+\.\d+)\b/.exec(c); if (pin) return pin[1];
  const baked = /"([^"]*sawbuck\.mjs)"/.exec(c); if (!baked) return '';
  try { const pk = JSON.parse(readFileSync(join(dirname(baked[1]), 'package.json'), 'utf8')); return pk && pk.name === 'sawbuck' && /^\d+\.\d+\.\d+/.test(String(pk.version)) ? String(pk.version) : ''; } catch { return ''; }
}
// our hook commands in a Claude Code settings file, each once
export function ourCommands(file) {
  let cfg; try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  return [...new Set(Object.values((cfg && cfg.hooks) || {}).flat()
    .flatMap((h) => (h && Array.isArray(h.hooks) ? h.hooks : [])).map((x) => x && x.command)
    .filter((c) => typeof c === 'string' && OURS.test(c)))];
}
// the oldest of these versions that is older than `than`, or ''
export function oldestOlder(versions, than) {
  return versions.filter((v) => v && older(v, than)).sort((a, b) => (older(a, b) ? -1 : older(b, a) ? 1 : 0))[0] || '';
}
