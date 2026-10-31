# Sawbuck: Glossary & Controlled Vocabulary

Sawbuck is a saddle: an isolated layer you attach to a repo that fits its shape
and responds when the repo moves. It reads the history (via Logbook) and a small
config of what to measure, runs the check when a change lands, and surfaces the
relevant past finding before the agent repeats a known mistake.

## The rule: one plain surface

Earlier drafts split terms into a "brand/human" surface (a mining metaphor) and a
plain "agent-facing" surface. That split is retired. There is now ONE surface, and
it is plain and scientific. The saddle is the brand and the architecture spine
(the name, `attach`, `fit`); it is NOT a vocabulary for every concept.

Why plain wins everywhere: an LLM has strong trained priors on words like
`regression`, `verified`, `invalid`. Metaphor jargon in the model's context forces
a gloss every session (token cost) and risks a misread (trajectory drift). Plain,
high-prior words serve the human reader and the agent equally, so we do not keep
two vocabularies.

## Canonical terms

| concept | term | notes |
|---|---|---|
| the product | **Sawbuck** | the only brand word |
| the history reader | **Logbook** | a lab logbook: plain and scientific |
| the verifier | **the check** (verb: *verify*) | runs the metrics on a change |
| a change that improved and holds | **verified** | |
| a change that made a guarded metric worse | **regression** | do-not-retry |
| a change that passed by weakening its test | **invalid** | the test was weakened, not the metric improved (engine verdict: `gamed`) |
| the accumulated record of outcomes | **results** | `results.json` |
| what Sawbuck leaves you | **verified history** | the findings you can trust |
| a surfaced past outcome | **finding** | |
| mounting Sawbuck to a repo | **attach** / **cinch** | `sawbuck attach <repo>` |
| reading the repo's shape | **fit** | history + config; a concept, not a command (it is what `attach` reads to decide what it can measure) |
| code still silenced in HEAD now | **debt** (suppression debt) | disabled/weakened tests + lint/type suppressions still live; `sawbuck debt` ranks it by severity and file fragility |
| the one-view accumulation | **inventory** | `sawbuck status`: what it has caught over time + the debt accruing now + whether it is armed here |

## The one humility rule

Findings are **leads, not conclusions**, verify against the diff before acting.

## Dispatch template

```
Sawbuck · {N} regressions charted · {N} invalid changes caught
   🆕 just learned: {reason} ({file})
```

## Note on engine verdicts

The check engine still emits its own verdicts (`gamed`, `fail`, `pass`); Sawbuck
maps them to the plain outcome words above (`gamed` → **invalid**, `fail` →
**regression**). Engine-internal names are not part of this surface.
