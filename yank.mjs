#!/usr/bin/env node
// yank.mjs — the live steering meter (the "reins" hook). Reads the current Claude
// Code session transcript and counts YANKS: turns where you corrected or redirected
// the agent. Deterministic, zero-dep, with a transparent definition shown in the
// output. It is a MIRROR — a number about how much you had to steer this session —
// and it pairs with the check: the check guards the turns you did NOT steer, where
// a miss is the real risk. The yank rate falling over time is the reins getting
// looser (the agent learning your cues).
//
// A yank is counted CONSERVATIVELY (precision over recall): a human turn, after the
// agent has acted, that OPENS by correcting or redirecting ("no", "don't",
// "actually", "stop", "undo", "instead", ...). Discursive steers buried mid-
// paragraph are deliberately NOT counted here — that is the LLM-harvest layer's job;
// this stays cheap, instant, and honest (an undercount with a clear definition beats
// an inflated guess).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// leading correction/redirect markers at the START of the turn (case-insensitive)
const LEAD = /^\s*["'(]?\s*(no\b|no,|nope\b|don'?t\b|do not\b|actually\b|wait\b|stop\b|undo\b|revert\b|instead\b|nah\b|hold on|rather\b|not (that|like|quite|what|really)|that'?s (not|wrong)|hmm,? ?no|why (did|are) you|you (shouldn'?t|weren'?t))/i;

function humanText(o) {
  if (!o || o.type !== 'user' || o.isMeta) return null;
  if (o.userType && o.userType !== 'external') return null;
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;      // tool output, not you
    const t = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ');
    return t || null;
  }
  return null;
}
const isNoise = (t) => {
  const s = t.trim();
  if (s.includes('<task-notification>') || s.startsWith('<task-id>')) return true; // injected
  if (s.replace(/\[Image #\d+\]/g, '').trim().length < 3) return true;             // image-only
  return false;
};

// tally(transcriptText) -> { turns, yanks, rate, recent } over YOUR typed turns.
export function tally(text) {
  let turns = 0, yanks = 0, seenHuman = false, prevAssistantActed = false;
  const recent = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant') { prevAssistantActed = true; continue; }
    const t = humanText(o);
    if (t === null || isNoise(t)) continue;
    const opener = !seenHuman; seenHuman = true;
    turns++;
    if (!opener && prevAssistantActed && LEAD.test(t)) {
      yanks++;
      recent.push(t.replace(/\s+/g, ' ').trim().slice(0, 48));
    }
    prevAssistantActed = false;
  }
  return { turns, yanks, rate: turns ? yanks / turns : 0, recent: recent.slice(-5) };
}

// Resolve the newest session transcript for a cwd. Claude Code stores transcripts
// under ~/.claude/projects/<encoded-cwd>/<id>.jsonl (path separators -> dashes).
// Best-effort: prefer the dir matching this cwd, else the newest across all. Never throws.
export function resolveSessionPath(explicit, cwd = process.cwd()) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  const key = cwd.replace(/[^A-Za-z0-9]/g, '-');
  let dirs = [];
  try { dirs = readdirSync(root).map((d) => join(root, d)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } }); }
  catch { return null; }
  const matched = dirs.filter((p) => p.endsWith('/' + key));
  const pool = matched.length ? matched : dirs;
  let best = null, bestT = 0;
  for (const full of pool) {
    let files = []; try { files = readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(full, f);
      try { const st = statSync(p); if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = p; } } catch {}
    }
  }
  return best;
}
