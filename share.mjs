// The findings seam: what Sawbuck finds (a rule you accepted, a reverted attempt it recovered, a gamed green it caught) is
// handed, once each, to whatever memory the person runs, through small sinks. Today: claude-mem's local worker, Claude
// Code's own auto-memory notes for the project, and a Markdown folder named in sawbuck.config.json ({"share":{"markdown":
// "<dir>"}}). A sink that is not there is skipped in silence; nothing is read back. Measured, twin bench 2026-11-08: a
// correction that lived only in the person's words came back 18 of 36 times through a memory layer's own notes and 0 to 2
// of 36 as a written rule, so the CLAUDE.md line stays the carrier and this adds reach. The check is not pluggable; this is.
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';

const KINDS = ['rule', 'revert', 'gamed', 'undone'];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'finding';
const applyLine = { rule: 'Hold to this on every task here, without being asked again.', revert: 'Do not redo this change. If asked for it, name the reason it was reverted and ask first.', gamed: 'Earn the green in the source. Never edit a test, grader or config to make it pass.', undone: 'Do not redo this change. If asked for it, name why it was undone and ask first.' };

function config(repo) { try { return JSON.parse(readFileSync(join(repo, 'sawbuck.config.json'), 'utf8')).share || {}; } catch { return {}; } }

// where a claude-mem worker would be: its port file, its settings, or its default of 37700 + uid % 100
export function memoryWorker({ home = homedir() } = {}) {
  const dir = join(home, '.claude-mem');
  if (!existsSync(dir)) return null;
  let port = 0;
  try { port = parseInt(readFileSync(join(dir, '.worker.port'), 'utf8').trim(), 10) || 0; } catch {}
  if (!port) { try { port = parseInt(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).CLAUDE_MEM_WORKER_PORT, 10) || 0; } catch {} }
  if (!port) { let uid = 0; try { uid = userInfo().uid; } catch {} port = 37700 + (uid % 100); }
  return { url: `http://127.0.0.1:${port}` };
}

// Claude Code keeps a project's notes under ~/.claude/projects/<path with / as ->/memory/, MEMORY.md as the index it loads
export const projectMemoryDir = (repo, home = homedir()) => join(home, '.claude', 'projects', resolve(repo).replace(/\//g, '-'), 'memory');

const sinks = {
  async 'claude-mem'(repo, f, { home, timeoutMs }) {
    const w = memoryWorker({ home }); if (!w) return { skipped: 'no claude-mem on this machine' };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const h = await fetch(`${w.url}/api/health`, { signal: ctl.signal }); if (!h.ok) throw new Error(`health ${h.status}`);
      const r = await fetch(`${w.url}/api/memory/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: f.title, text: f.text || f.title, cwd: repo }), signal: ctl.signal });
      if (!r.ok) throw new Error(`save ${r.status}`);
      return { where: w.url };
    } catch { return { skipped: `no claude-mem worker answered at ${w.url}` }; } finally { clearTimeout(timer); }
  },
  async 'auto-memory'(repo, f, { home }) {
    // only where Claude Code has already been used in this repo (its project directory exists); one note, one index line
    const dir = projectMemoryDir(repo, home); const proj = join(dir, '..');
    if (!existsSync(proj)) return { skipped: 'Claude Code has no project directory for this repo' };
    mkdirSync(dir, { recursive: true });
    const name = `${f.kind}-${slug(f.title)}`; const file = join(dir, `${name}.md`);
    const body = `---\nname: ${name}\ndescription: ${f.title.replace(/\n/g, ' ')}\nmetadata:\n  type: feedback\n  source: sawbuck\n---\n\n${f.title}\n\n**Why:** ${f.text || 'Found by Sawbuck in this repo.'}\n**How to apply:** ${applyLine[f.kind]}${f.files && f.files.length ? ` Files: ${f.files.join(', ')}.` : ''}\n`;
    writeFileSync(file, body);
    const idx = join(dir, 'MEMORY.md'); let have = ''; try { have = readFileSync(idx, 'utf8'); } catch {}
    const line = `- [${f.title.replace(/[\[\]]/g, '')}](${name}.md) — ${f.kind}, from Sawbuck`;
    if (!have.includes(`](${name}.md)`)) appendFileSync(idx, (have && !have.endsWith('\n') ? '\n' : '') + line + '\n');
    return { where: file };
  },
  async markdown(repo, f, {}) {
    const c = config(repo); if (!c.markdown) return { skipped: 'no share.markdown folder in sawbuck.config.json' };
    const dir = isAbsolute(c.markdown) ? c.markdown : join(repo, c.markdown);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${f.kind}-${slug(f.title)}.md`);
    writeFileSync(file, `---\ntitle: ${f.title.replace(/\n/g, ' ')}\nkind: ${f.kind}\nsource: sawbuck\nat: ${new Date().toISOString()}\n${f.files && f.files.length ? `files: [${f.files.map((x) => JSON.stringify(x)).join(', ')}]\n` : ''}---\n\n${f.title}\n\n${f.text || ''}\n\n${applyLine[f.kind]}\n`);
    return { where: file };
  },
};

// The notes this file wrote for a repo, for `detach --purge`: each carries `source: sawbuck` in its front matter, in
// Claude Code's notes folder for the repo and in the Markdown folder the repo names. A note a person wrote there, and a
// line of theirs in the index, is not ours. What a claude-mem worker was sent is in that tool, not in a file here.
const oursNote = (f) => { try { const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(f, 'utf8')); return !!m && /^\s*source: sawbuck\s*$/m.test(m[1]); } catch { return false; } };
export function handedOnNotes(repo, { home = homedir() } = {}) {
  const c = config(repo); const dirs = [projectMemoryDir(repo, home)];
  if (c.markdown) dirs.push(isAbsolute(c.markdown) ? c.markdown : join(repo, c.markdown));
  const files = [];
  for (const d of dirs) { let names = []; try { names = readdirSync(d); } catch {} for (const n of names) if (n.endsWith('.md') && oursNote(join(d, n))) files.push(join(d, n)); }
  // the index Claude Code loads: our lines are the ones that link a note of ours
  const idx = join(dirs[0], 'MEMORY.md'); let index = null;
  try { const had = readFileSync(idx, 'utf8'); const gone = new Set(files.filter((f) => f.startsWith(dirs[0])).map((f) => f.slice(dirs[0].length + 1))); const kept = had.split('\n').filter((l) => ![...gone].some((n) => l.includes(`](${n})`))); if (kept.length !== had.split('\n').length) index = { file: idx, text: kept.join('\n') }; } catch {}
  // and where the record says a note went (0.2.0 on), for a note in a folder the config no longer names. Only a file
  // that still carries our mark: the record is a file anyone can write, and this list is deleted from.
  let toWorker = 0;
  try { for (const l of readFileSync(join(repo, '.sawbuck', 'shared.jsonl'), 'utf8').split('\n').filter(Boolean)) { let e; try { e = JSON.parse(l); } catch { continue; } if (e.sink === 'claude-mem') toWorker++; else if (typeof e.where === 'string' && e.where.endsWith('.md') && !files.includes(e.where) && oursNote(e.where)) files.push(e.where); } } catch {}
  return { files, index, toWorker };
}

// finding = { kind: rule | revert | gamed, title, text?, files? }. Returns one entry per sink tried.
export async function shareFinding(repo, finding, { home = homedir(), to = null, timeoutMs = 800 } = {}) {
  const f = { kind: KINDS.includes(finding.kind) ? finding.kind : 'rule', title: String(finding.title || '').trim(), text: String(finding.text || '').trim(), files: finding.files || [] };
  if (!f.title) return [{ sink: '-', skipped: 'nothing to share: no title' }];
  if (process.env.SAWBUCK_SHARE === 'none') return [{ sink: '-', skipped: 'SAWBUCK_SHARE=none' }];
  const wanted = to || config(repo).to || Object.keys(sinks);
  const log = join(repo, '.sawbuck', 'shared.jsonl'); let seen = ''; try { seen = readFileSync(log, 'utf8'); } catch {}
  const out = [];
  for (const name of wanted) {
    if (!sinks[name]) { out.push({ sink: name, skipped: 'unknown sink' }); continue; }
    const key = createHash('sha256').update(`${name}\n${f.title}\n${f.text}`).digest('hex').slice(0, 16);
    if (seen.includes(`"key":"${key}"`)) { out.push({ sink: name, skipped: 'already shared' }); continue; }
    let r; try { r = await sinks[name](repo, f, { home, timeoutMs }); } catch (e) { r = { skipped: String(e.message || e) }; }
    if (r.where) { try { mkdirSync(join(repo, '.sawbuck'), { recursive: true }); appendFileSync(log, JSON.stringify({ key, sink: name, kind: f.kind, title: f.title, at: new Date().toISOString(), ...(name === 'claude-mem' ? {} : { where: r.where }) }) + '\n'); } catch {} }
    out.push({ sink: name, ...r });
  }
  return out;
}

// the old name, kept for the hook: a rule or lead with a title and the words behind it
export const share = (repo, { title, text, kind = 'rule', files }, opts) => shareFinding(repo, { kind, title, text, files }, opts).then((rs) => { const ok = rs.filter((r) => r.where); return ok.length ? { sent: true, to: ok.map((r) => `${r.sink} (${r.where})`).join(', '), name: ok.map((r) => r.sink).join(', ') } : { sent: false, reason: rs.map((r) => `${r.sink}: ${r.skipped}`).join('; ') }; });
