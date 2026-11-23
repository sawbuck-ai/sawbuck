// lookback.mjs   Each commit of a stretch of work, held against a contract: its protected paths and the counts it keeps
// beside the tests. The test run itself is not replayed: it is slow, and on 340 real commits every one of the 82 that
// were sent back was sent back for a protected path or a count (proof-bench/contract-replay). Read-only: the engine
// measures in throwaway copies. Shared by `sawbuck contract --try` (the last n commits) and `sawbuck align` (the work
// since a conversation began), so the two read a commit the same way.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PW } from './bins.mjs';
import { mandateHits, gitNames } from './contract.mjs';

export const COUNTS = new Set(['test_count', 'skipped_tests', 'suppressions', 'assertions']);

// commits: [{ sha, parent, ... }]. Returns the ones that would have been sent back and why, how many could not be read,
// and how many signed the contract.
export async function readCommits(repo, cfg, commits) {
  const { check } = await import(pathToFileURL(PW).href);
  const counts = (cfg.metrics || []).filter((m) => m && COUNTS.has(m.name));
  const fast = { ...cfg, mandates: [], metrics: counts };
  const back = []; let unread = 0, signed = 0;
  // the commit that signed the contract adds the very files the contract protects, and a rule a change adds does not
  // apply to that change: it is counted apart, not as sent back
  const holds = (ref) => { try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${ref}:promptwheel.config.json`], { stdio: 'ignore' }); return true; } catch { return false; } };
  for (const c of commits) {
    if (!holds(c.parent) && holds(c.sha)) { signed++; continue; }
    // protected paths: the diff's own file names against the rules as they would be written. (The engine applies a rule
    // only where it was already in force at the commit before, and here it never was.)
    let paths = []; try { paths = mandateHits(repo, gitNames(repo, ['diff', '--name-only', '--no-renames', c.parent, c.sha, '--']), { list: cfg.mandates || [] }).map((m) => ({ name: m.name, files: m.files || [] })); } catch { unread++; continue; }
    let rep = { metrics: [] }; if (counts.length) { try { rep = check({ repo, base: c.parent, head: c.sha, config: fast, detectGaming: false, repeat: 1 }); } catch { unread++; continue; } }
    const worse = (rep.metrics || []).filter((m) => m.guard && m.ok === false && m.status === 'regressed').map((m) => m.name);
    if (paths.length || worse.length) back.push({ ...c, paths, worse, counts: Object.fromEntries((rep.metrics || []).filter((m) => worse.includes(m.name)).map((m) => [m.name, [m.before, m.after]])) });
  }
  return { back, unread, signed, counted: counts.length };
}
