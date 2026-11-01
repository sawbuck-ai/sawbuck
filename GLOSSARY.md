# Sawbuck: Glossary & Controlled Vocabulary

Sawbuck is a saddle: an isolated layer you attach to a repo that fits its shape
and responds when the repo moves. It reads the history (via its memory provider,
logbook by default) and a small config of what to measure, runs the check when a
change lands, and surfaces the relevant past finding before the agent repeats a
known mistake.

## The rule: one plain surface

Earlier drafts split terms into a "brand/human" surface (a mining metaphor) and a
plain "agent-facing" surface. That split is retired. There is now ONE surface, and
it is plain and scientific. The saddle is the brand and the architecture spine
(the name, `attach`, `fit`); it is NOT a vocabulary for every concept.

Why plain wins everywhere: an LLM has strong trained priors on words like
`regression`, `verified`, `gamed`. Metaphor jargon in the model's context forces
a gloss every session (token cost) and risks a misread (trajectory drift). Plain,
high-prior words serve the human reader and the agent equally, so we do not keep
two vocabularies.

## Canonical terms

| concept | term | notes |
|---|---|---|
| the product | **Sawbuck** | the only brand word |
| the memory (the role) | **memory**; default provider **Logbook** | the relevant history + live debt for what you touch. logbook (a lab logbook: plain, scientific) is a standalone product and the default fill; the role is a socket, swap your own via the Memory Contract |
| the verifier | **the check** (verb: *verify*) | runs the metrics on a change |
| a change that improved and holds | **verified** | |
| a change that made a guarded metric worse | **regression** | do-not-retry |
| a change that passed by faking the metric | **gamed** | the win came from editing the test, config, or grader, not the source (the engine verdict, and the word every Sawbuck surface uses) |
| the accumulated record of outcomes | **results** | `results.json` |
| what Sawbuck leaves you | **verified history** | the findings you can trust |
| a surfaced past outcome | **finding** | |
| mounting Sawbuck to a repo | **attach** / **cinch** | `sawbuck attach <repo>` |
| reading the repo's shape | **fit** | history + config; a concept, not a command (it is what `attach` reads to decide what it can measure) |
| code still silenced in HEAD now | **debt** (suppression debt) | disabled/weakened tests + lint/type suppressions still live; `sawbuck debt` ranks it by severity and file fragility |
| the one-view accumulation | **inventory** | `sawbuck status`: what it has caught over time + the debt accruing now + whether it is armed here |

## The two interfaces (a socket and a standard)

Sawbuck composes two roles, and they are open in opposite directions. Keeping them
straight is what stops "Sawbuck, then logbook?" confusion: logbook is not a second
brand bolted on, it is the default fill for one of the two roles.

- **the check** is a *standard we publish* (the Verified-Outcome Contract, see
  CONTRACT.md): other tools conform to it, or embed it. promptwheel is the reference
  implementation. It is not swappable, because the un-gameable source re-proof is the
  asset; what you plug in is *what to measure*.
- **the memory** is a *socket we expose*: you fill it with any provider. logbook is
  the default, carried along so it works out of the box, and it is its own product you
  can also run on its own.

In one line: the check is a standard for others to meet; the memory is a socket for
others to fill.

## The one humility rule

Findings are **leads, not conclusions**, verify against the diff before acting.

## Dispatch template

```
Sawbuck · {N} regressions charted · {N} gamed changes caught
   🆕 just learned: {reason} ({file})
```

## Note on engine verdicts

The check engine emits verdicts (`gamed`, `fail`, `pass`); the surface keeps **gamed**
as-is (it is vivid and used on every surface) and maps `fail` → **regression** and
`pass` → **verified**. ("Invalid" was an earlier softening of `gamed` that no surface
adopted; `gamed` is canonical.)
