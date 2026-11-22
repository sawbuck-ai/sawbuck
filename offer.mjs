// offer.mjs   No dead ends (his word, 2026-11-22: "maybe when it says no repo found says like press this key to start
// that"). Where Sawbuck would stop because the folder is not a git repository, it says what it can do instead. In a
// terminal it asks once: Enter starts a repository here (git init) and goes on with the same command; q stops. Anywhere
// else (a pipe, CI, a hook, an agent running it through a tool) nothing waits: the exit code is the one it always was
// (64, could not run), and the exact commands to run are said. It never commits the person's files: a first commit
// could take a secret in, so that stays theirs.
import { createInterface } from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';

// a person at a terminal, and nothing that runs Sawbuck unattended
export const canAsk = () => !!(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI && !process.argv.includes('--hook') && !process.argv.includes('--yes');

// dir: the folder; then: what runs after git init, in words ("sawbuck contract")
export async function offerRepo(dir, then) {
  const say = `${dir} is not a git repository yet. Sawbuck checks each change against git history, so it needs one.`;
  const init = `git init${dir === process.cwd() ? '' : ` ${JSON.stringify(dir)}`}`;
  if (!canAsk()) { process.stderr.write(`sawbuck: ${say}\n  To start one: ${init}, then ${then}.\n`); process.exit(64); }
  process.stdout.write(`sawbuck: ${say}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => { rl.question(`  Press Enter to start one here (git init, then ${then}), or q and Enter to stop: `, r); rl.on('close', () => r('q')); rl.on('SIGINT', () => rl.close()); });
  rl.close();
  if (/^\s*q/i.test(a)) { process.stdout.write('  Nothing was done.\n'); process.exit(64); }
  try { execFileSync('git', ['init', '-q', dir], { stdio: ['ignore', 'inherit', 'inherit'] }); } catch { process.stderr.write('sawbuck: git init did not work here, so nothing else was done\n'); process.exit(64); }
  process.stdout.write(`  Started a git repository in ${dir}. Nothing of yours is committed: commit your work when you are ready (git add, then git commit).\n\n`);
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit' });   // the same command, now in a repository
  process.exit(r.status ?? 1);
}
