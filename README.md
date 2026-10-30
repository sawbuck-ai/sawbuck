# sawbuck

**A coding loop that can't keep a fake win.**

AI agents are great at making tests pass. Sometimes they make them pass by *editing the test*. Your CI goes green, you ship, and the bug is still there. Sawbuck catches that: it re-proves every win from the agent's **source** edits alone, so a green that came from weakening a test reads **invalid**. And it remembers what broke here before, so the agent stops repeating it.

```sh
npm i -g sawbuck         # also pulls the promptwheel + @promptwheel/logbook engines
cd your-repo
sawbuck attach           # wire it into the repo (a git post-commit hook)
# or, once, for every project in Claude Code:
sawbuck attach --user    # user-level hooks that profile-switch by cwd
```

On each change:

```
$ sawbuck check
sawbuck: invalid recorded on test.js       (the win came from editing the test, not the source)
```

## What it does

- **Verifies the win.** `check` re-runs your metric from the source diff alone. A faked green (a deleted, weakened, or skipped test; a mocked grader; an edited golden file) reads `invalid`. Deterministic, zero-LLM, $0, and it cannot be obfuscated against because it never reads the trajectory (89% recall on a labeled gaming benchmark).
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
| `sawbuck run --attempt '<agent cmd>'` | thin harness: load context, run one attempt through the keep-if-verified gate |
| `sawbuck trace` · `sawbuck doctor` · `detach --verify` | show the footprint; check the attachment resolves; prove a clean removal |

Each repo needs a `promptwheel.config.json` saying what to measure (your tests, lint, coverage, or an eval).

## The engines

Sawbuck is thin glue over two tools it depends on:

- **promptwheel** : the check (the deterministic outcome gate).
- **@promptwheel/logbook** : the memory (git history as agent memory; also ships an MCP server for on-demand lookups).

MIT.
