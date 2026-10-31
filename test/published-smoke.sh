#!/usr/bin/env bash
# Published-layout smoke test. The node:test suite resolves the engines via the
# monorepo SIBLING path (../referee, ../logbook), so it never exercises how a real
# `npm i sawbuck` resolves them from node_modules. That gap shipped the 0.1.2 bug:
# @promptwheel/logbook's `exports` maps only "." to its bin, so
# require.resolve('@promptwheel/logbook/bin/logbook.mjs') throws in an install and
# the memory half (init/rank/context) broke.
#
# This packs the glue, installs it next to the REAL published engines, and runs the
# commands that use require.resolve. Needs network (pulls the engines from npm), so
# it is NOT part of `npm test` - run it before every publish.
#
#   bash test/published-smoke.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"        # packages/sawbuck (or the flat repo root)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "packing $HERE ..."
TGZ="$(cd "$HERE" && npm pack --pack-destination "$TMP" 2>/dev/null | tail -1)"
cd "$TMP"; echo '{"name":"sawbuck-smoke","private":true}' > package.json
echo "installing the pack + the published engines ..."
npm i "$TMP/$TGZ" >/dev/null 2>&1
SB="$TMP/node_modules/.bin/sawbuck"

R="$TMP/r"; mkdir -p "$R"; cd "$R"
git init -q; git config user.email t@t; git config user.name t; git config commit.gpgsign false
echo '{"name":"x","type":"module","scripts":{"test":"node --test"}}' > package.json
printf 'export const a = 1; // eslint-disable-line\n' > a.js
git add -A && git commit -qm seed

fail=0
pass() { printf '  OK   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fail=1; }

# the resolution that broke in 0.1.2: init investigates via the logbook engine.
# capture then match - `grep -q` in a pipe under `pipefail` SIGPIPEs the producer and reads as a false fail.
init_out="$("$SB" init --yes 2>&1 || true)"
case "$init_out" in *"investigated this repo"*) pass "sawbuck init investigates via logbook";; *) bad "sawbuck init did not investigate (engine resolution)";; esac
# rank/context also resolve the logbook engine
printf 'export const a = 2; // eslint-disable-line\n' > a.js && git commit -qam touch
if "$SB" rank --file a.js >/dev/null 2>&1; then pass "sawbuck rank resolves logbook"; else bad "sawbuck rank crashed"; fi
# the check resolves the promptwheel engine
if "$SB" --version >/dev/null 2>&1; then pass "sawbuck bin runs"; else bad "sawbuck bin missing"; fi

if [ "$fail" = 0 ]; then echo "PUBLISHED SMOKE: PASS"; else echo "PUBLISHED SMOKE: FAIL"; exit 1; fi
