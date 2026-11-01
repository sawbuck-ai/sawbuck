#!/usr/bin/env node
// mem0.mjs, a REFERENCE semantic memory provider for Sawbuck's Memory Contract: Mem0 (mem0.ai) as the
// memory. It is the THIRD contract implementation and a deliberately DIFFERENT axis from the other two:
// a networked, LLM-backed semantic store, where logbook is deterministic git-truth and obsidian is
// local notes. Because of that it is the one provider that is NOT offline: it needs the NETWORK and a
// MEM0_API_KEY. So it is an OPTIONAL provider isolated behind the socket, never part of the zero-network
// glue. Zero npm deps (Node >= 18 global fetch).
//
// Opt in: SAWBUCK_MEMORY=logbook,mem0 and MEM0_API_KEY=... (compose it WITH logbook so logbook stays the
// git-truth + debt provider and Mem0 adds recalled semantic context).
//
//   recall --file P [--file Q] --json   semantic search of your Mem0 memories -> Finding[] (kind note)
//   record --ref SHA --summary S --by WHO [--side X] [--evidence-file F]   add the finding as a memory
//   debt   --json                        EXITS NONZERO: a semantic store is not git-aware (git-truth
//                                         lives in a git provider like logbook); the contract skips it.
//
// Config: MEM0_API_KEY (required for live calls; without it recall degrades to [] and record errors),
// MEM0_USER_ID (scope; default the repo folder name), MEM0_BASE_URL (default https://api.mem0.ai),
// MEM0_TIMEOUT_MS (default 8000). NOTE: record SENDS the finding text to Mem0's service (your opt-in).

import { basename } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flagAll = (n) => argv.reduce((a, v, i) => (argv[i - 1] === n ? [...a, v] : a), []);
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? (argv[i + 1] ?? true) : d; };
const die = (msg, code = 2) => { process.stderr.write(`mem0 provider: ${msg}\n`); process.exit(code); };

const userId = () => process.env.MEM0_USER_ID || basename(process.cwd()) || 'sawbuck';

// one bounded POST to the Mem0 platform; null on any network/HTTP/auth failure, so a read never hangs
// or crashes the caller. (A semantic recall is on-demand, never per-turn, so the timeout is generous.)
async function post(path, body, key) {
  const base = (process.env.MEM0_BASE_URL || 'https://api.mem0.ai').replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), +(process.env.MEM0_TIMEOUT_MS) || 8000);
  try {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

if (cmd === 'debt') {
  die('debt is unsupported by a semantic store (git-truth lives in a git provider like logbook)', 2);
}

if (cmd === 'recall') {
  const key = process.env.MEM0_API_KEY;
  if (!key) { console.log('[]'); process.exit(0); }                 // no key -> no memories, not an error
  const paths = flagAll('--file');
  if (!paths.length) { console.log('[]'); process.exit(0); }
  const query = `code, decisions, and gotchas related to: ${paths.map((p) => basename(p)).join(', ')}`;
  const res = await post('/v3/memories/search/', { query, filters: { user_id: userId() }, top_k: 8 }, key);
  const results = res && Array.isArray(res.results) ? res.results : [];
  const findings = results.map((m) => ({
    kind: 'note',
    path: null,                                                     // a semantic memory is topical, not file-pinned
    ref: m.id || null,
    date: (m.created_at || '').slice(0, 10) || null,
    summary: String(m.memory || '').slice(0, 280),
  })).filter((f) => f.summary);
  console.log(JSON.stringify(findings));
  process.exit(0);
}

if (cmd === 'record') {
  const key = process.env.MEM0_API_KEY;
  if (!key) die('cannot record: MEM0_API_KEY is unset', 2);
  const ref = String(flag('--ref', '')), summary = String(flag('--summary', '')), by = String(flag('--by', 'sawbuck'));
  const side = flag('--side', ''), evidence = flag('--evidence-file', '');
  const metadata = { sawbuck: 'finding', ref, by, ...(side ? { side: String(side) } : {}), ...(evidence ? { evidence: String(evidence) } : {}) };
  // infer:false stores the finding verbatim (no LLM extraction); we want the exact note, not a paraphrase.
  const res = await post('/v3/memories/add/', { messages: [{ role: 'user', content: summary }], user_id: userId(), metadata, infer: false }, key);
  if (res === null) die('record failed (network or auth)', 1);
  console.log('recorded');
  process.exit(0);
}

die(`unknown command '${cmd || ''}' (recall | debt | record)`, 2);
