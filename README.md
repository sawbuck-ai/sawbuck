# sawbuck

**Sign your agent to a contract so it does what you want.**

A saddle for your coding harness. You write the contract (what a real win looks like); Sawbuck enforces it, re-proving every win from the agent's **source** edits alone, so a result that only passed because the agent edited the test, mocked the grader, or loosened a rule gets flagged and reverted. Deterministic, zero-LLM, un-gameable. Break it in and it carries your repo's history along: what broke in these files before, surfaced before you touch them.

> Sawbuck is the reference implementation of the [Verified-Outcome Contract](CONTRACT.md): the open interface for a coding loop you can trust.

```sh
# 1 · try it (no install, no commitment): verify your latest change right now
npx sawbuck check

# 2 · watch it live: attach once to this repo (a project-scoped Claude Code hook)
npm i -g sawbuck
sawbuck attach --claude
```

**Zero-config:** it auto-detects your test command, so there is nothing to write to start.
On attach it tells you exactly what it can measure here (and how to fix it if it can't).
`sawbuck init` is only for *customizing* what it measures (coverage, latency, a cost budget).
In CI instead of a local hook? use the GitHub Action. For every project at once: `sawbuck attach --user`.

On each change:

```
$ sawbuck check
sawbuck: gamed recorded on test.js       (the win came from editing the test, not the source)
```

## What it does

- **Verifies the win.** `check` re-runs your metric from the source diff alone. A faked green (a deleted, weakened, or skipped test; a mocked grader; an edited golden file) reads `gamed`. Deterministic, zero-LLM, $0, and it cannot be obfuscated against because it never reads the trajectory (89% recall on a labeled gaming benchmark).
- **Remembers what broke.** `context` and `rank` surface the relevant history (reverts, fragile areas, test-weakening) for the files you are touching: a ranked trail guide, before you act.
- **Rides on, does not replace.** Sawbuck is the verify + memory layer. Your agent and your loop stay yours.
- **Clean on and off.** `attach` touches nothing in your worktree (the hook lives in `.git/`, the record is excluded locally); `detach` is a true inverse. `trace` shows every byte it placed, and `detach --verify` proves the repo came back unchanged.

## Commands

| command | what |
|---|---|
| `sawbuck attach [--claude \| --user]` | wire the reflex (git post-commit / project Claude hooks / user-level for every project) |
| `sawbuck detach [--claude \| --user]` | remove it |
| `sawbuck check [--base R --head R]` | verify a commit; record a regression or a gamed win |
| `sawbuck context` · `sawbuck rank` | the ranked relevant history for the current change |
| `sawbuck debt` | the whole-repo live suppression debt: what is still silenced in HEAD now, disabled tests first, heaviest files ranked |
| `sawbuck run --attempt '<agent cmd>'` | thin harness: load context, run one attempt through the keep-if-verified gate |
| `sawbuck trace` · `sawbuck doctor` · `detach --verify` | show the footprint; check the attachment resolves; prove a clean removal |

Each repo needs a `promptwheel.config.json` saying what to measure (your tests, lint, coverage, or an eval).

## The engines

Sawbuck is thin glue over two tools it depends on:

- **promptwheel** : the check (the deterministic outcome gate).
- **@promptwheel/logbook** : the memory (git history as agent memory; also ships an MCP server for on-demand lookups).

MIT.
