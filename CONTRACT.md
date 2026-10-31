# The Verified-Outcome Contract

*Put your coding agent under contract: a win counts only if it survives verification from the source alone, not because the agent said so. The terms below are not a promise the agent makes, they are a result anyone can re-prove.*

**Status:** Draft v0.1 · **License:** MIT · **Reference implementation:** [Sawbuck](https://github.com/sawbuck-ai/sawbuck) (the saddle), [promptwheel](https://github.com/promptwheel-ai/promptwheel) (the check), [@promptwheel/logbook](https://github.com/promptwheel-ai/logbook) (the context record)

This is an open interface for making an AI coding harness trustworthy. It defines how a loop's wins get verified, what a verdict looks like, what counts as gaming the goalposts, and how a repo's history is carried along. Any harness can emit or consume it without using this code. Sawbuck is a reference saddle that implements it; it is not the only possible one.

The contract has one property that holds all of it together: a verdict is **deterministic and reproducible from `(base, head, config)` alone**. No LLM is in the path, and nothing is read from the agent's trajectory, so the result cannot be obfuscated against and does not change when you ask it twice.

---

## 1. The reward contract (exit codes)

The per-turn signal a loop consumes. The check (`run`) exits:

| Exit | Verdict | Meaning | A conforming loop should |
|------|---------|---------|--------------------------|
| `0` | `pass` | The win is real: it survived a source-only re-proof and no guard regressed. | Keep the change. |
| `1` | `fail` | A guarded metric regressed beyond the measured noise band. | Revert. |
| `2` | `gamed` | A metric improved only by editing the goalposts (test, grader, golden, config), not the source. | Revert and flag. |
| `3` | `inconclusive` | Nothing could be certified: a guard measured nothing, or the delta sat inside noise. | Do not trust the green; do not keep on this signal alone. |

The agent consumes this as a per-turn reward it cannot inflate. The harness consumes the same exit as a merge gate the agent cannot self-clear.

## 2. The verdict schema (the audit artifact)

`run --json` emits a report reproducible from `(base, head, config)` alone:

```json
{
  "base": "a1b2c3d",
  "head": "e4f5g6h",
  "mode": "refs",
  "repeat": 3,
  "cohort": "ci",
  "verdict": "gamed",
  "subsystems": ["api", "auth"],
  "metrics": [
    {
      "name": "tests_pass",
      "direction": "pass",
      "guard": true,
      "before": 0,
      "after": 1,
      "delta": 1,
      "status": "improved",
      "ok": true,
      "noise": { "band": 0, "runs": 3 },
      "gamed": true,
      "retained": 0.0,
      "gamingReason": "the win did not survive reverting the test changes"
    }
  ]
}
```

Fixed vocabularies (a conforming implementation uses exactly these):

- `verdict` ∈ `pass | fail | gamed | inconclusive`
- `metric.status` ∈ `improved | regressed | unchanged | inconclusive | unmeasurable`
- `direction` ∈ `up | down | pass` (the direction that counts as better; `pass` means a 0/1 gate)

`retained` is the fraction of a metric's gain that survived the source-only re-run (§3). `noise` is the measured jitter band across `repeat` runs; a delta inside it is `inconclusive`, never a regression.

## 3. The integrity boundary (what counts as gaming)

This is the part that makes "moving the goalposts" objective rather than a judgment call.

A win is **`gamed`** when it does not survive a **source-only re-run**: revert every non-source change the agent made, re-measure, and see how much of the gain remains (`retained`). If `retained` falls below `gamingThreshold` (default `0.5`), the verdict is `gamed`.

- **Non-source** (reverted before the re-run): tests, specs, fixtures, snapshots and golden files, graders, config, lockfiles, CI definitions, build gates, and any path the repo opts into via `evaluatorPaths`.
- **Source**: everything else, the code the change was supposed to be about.
- **`evaluatorPaths`**: an opt-in allowlist a repo declares for its own gate files (a threshold file, a budget, a ruleset), because a generic name is a classifier risk and only the repo owner knows which files are the goalposts.

**Honest boundary, stated not hidden:** a cheat that lives *inside the source itself* (code that behaves correctly only while a test is watching) is invisible to a source-only re-run, by construction. The contract catches every out-of-source goalpost move; it does not claim to catch a source-resident backdoor. That needs held-out or behavioral analysis, which is a different layer.

**Protected terms (declared, optionally enforced).** `evaluatorPaths` is also the declaration surface for immutability: the files a repo names there are its fixed terms, the goalposts the agent does not get to move. The baseline is detection (a win that depended on changing a protected term reads `gamed`). A stronger conformance level *enforces* it: the audit gate (CI, or a hook the agent cannot bypass) fails any change to a protected term unless a human signs off, so the terms cannot be moved mid-game. Note the honest limit: a file cannot be made truly immutable to an agent that has write access to the repo. The guarantee comes from the un-bypassable gate, not from the filesystem.

## 4. The context record (the trail knowledge)

A conforming saddle also carries the repo's history as deterministic memory: a ledger derived from git (hotspots, reverted approaches, suppressed or weakened tests, fragile areas), surfaced per turn as a ranked slice for the files being touched. It is a projection of git, never a second source of truth, so it is always reconstructable and never drifts from what actually happened.

---

## Conformance

- A conforming **check** emits §2 and the §1 exit contract, computed deterministically, with no LLM and nothing read from the agent's trajectory.
- A conforming **loop** consumes the §1 exit code as its per-turn reward.
- A conforming **harness** runs the check as the audit gate (so the agent cannot self-clear its own win).
- A conforming **context record** is a deterministic projection of git (§4).

An implementation may support a subset and say so. The reference saddle (Sawbuck) implements all four.

## Versioning

This contract is versioned with semver. `v0.1` is a draft: the vocabularies in §1 and §2 are stable, the exact field set in §2 may still grow (additively) before `v1.0`.
