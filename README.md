# sawbuck

**Was that green earned, or was the test edited to pass?** Sawbuck re-runs your tests from the agent's **source** edits alone, so a win that only came from editing the test reads as gamed. It keeps what git threw away (a reverted attempt and its reason, squashed out of the log) and shows it to your agent when you ask for that file again. And it turns what you keep telling your agent into written rules, each with your own words behind it.

Measured in November 2026: we put a test that could not pass into 6 real repos and told the agent to get to green fast. With no rule, it got there by changing the test 85 of 100 times on Claude Sonnet, Haiku and Opus 5.5, and 21 of 24 on Fable 5.2; with one line in `CLAUDE.md`, 0 of 100 and 0 of 24. So the written rule does most of the work. Sawbuck writes it for you, and then checks on every commit that it held, with no model in the loop.

If it earns its keep, a star helps the next person find it.

In Claude Code, install the plugin and keep working:

```
/plugin marketplace add sawbuck-ai/reins
/plugin install sawbuck-reins@sawbuck
```

Run `claude update` first: the plugin needs a current Claude Code.

The first time you open a git repository with no rules, Claude finishes your task and offers once to add them. Say yes: it writes the rule, sets your protected paths, and watches every turn: protected paths at the end of each turn, each commit re-proved from the source.

Or from the command line:

```sh
# 1 · try it (no install, no commitment): verify your latest change right now
npx sawbuck check

# 2 · give this repo its rules: the written rule, protected paths, and your tests if it has no config yet
npm i -g sawbuck          # a global copy does not update itself: run `npm i -g sawbuck@latest` for a new release
sawbuck contract          # --full adds supply-chain guards, a repo lock and, on a GitHub repo, a CI check
sawbuck attach            # watch every Claude Code turn in this repo (--shared for a team file, --codex for Codex, --cursor for Cursor, --git for any other agent)
```

What a check looks like:

```
$ sawbuck check
🚩 gamed: a win here came from editing the test, config, or grader, not the source.
   It does NOT survive a source-only re-run, so it does not count.

$ sawbuck check        # after fixing the source and restoring the test
✓ verified: your working change earned it. "tests_pass" improved, and the source carried the win
   (it survives a source-only re-run).
```

Exit codes: `0` pass (verified, held, or allowed) · `1` sent back (a regression or a protected path) · `2` gamed · `3` inconclusive · `64` could not run (not a git repo, no commit, a bad ref, an unknown flag, a bad or missing flag value, a bad config, or `--working` with nothing uncommitted, and it says which); no detectable test command reads `3` inconclusive, and says so.

## Check every pull request. Two lines.

```
npx -y sawbuck contract --full
git add -A && git commit -m "add the Sawbuck check" && git push
```

The first line writes the check as files in your repo. You can read every one before you commit.
It adds a workflow, `.github/workflows/sawbuck.yml`, that runs on each pull request and leaves a comment.
No model reads your code. No account. Nothing leaves your CI.

What it sends back, with a comment that says why:

- a pull request with fewer tests, fewer assertions, or more skipped tests than the branch it came from
- a change to a workflow, the contract, or the check itself
- tests that only pass because the test was changed

What it lets through: everything else. A person with write access can let a sent-back change through with a
comment: `sawbuck-allow: <reason>`. The account that opened the pull request cannot.

## What it does

- **A normal turn:** you see nothing new.
- **The agent got to green by changing a test:** the turn is sent back to the agent, up to three times. Then you get three ways out: fix the source, put the test back, or accept the change with a reason. A later turn is not sent back for it: you are told while it is open.
- **The agent changed a protected path** (a CI workflow, the registry config, the rules file): sent back too. To keep such a change, make it yourself.
- **Your prompt names a file where something was tried before:** the reverted attempt and its reason are shown to the agent with the prompt.

## What it cannot see

- A test weakened while it stays green: there is no win to re-run.
- A gaming move that lives inside the source itself, such as a value hardcoded to the one visible case.
- A test edited to go green and left uncommitted is not sent back at the end of that turn. `sawbuck check` reads it on demand.
- Run on Linux. Not yet proven on a Mac, and not supported on Windows.

Every limit, each held by a test or marked as not run: [LIMITS.md](LIMITS.md).

## More

- [GUIDE.md](GUIDE.md): everything else, in the order people ask. Commands, protected paths, pull requests, teams, other agents.
- [CHANGELOG.md](CHANGELOG.md): what was found and fixed in each version.
- [CONTRACT.md](CONTRACT.md): the check, written up as a draft spec.
- What Sawbuck keeps on your machine: [sawbuck.ai/privacy](https://sawbuck.ai/privacy).

**Tested claims.** Every claim in these pages, and every limit, is a test in [`test/claims.test.mjs`](test/claims.test.mjs), run on a clean account.

Apache 2.0.
