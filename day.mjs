// day.mjs: the day a record was written, as the clock of this machine has it.
// A record keeps the instant in UTC. Shown as its first ten characters it reads a day ahead for anyone west of
// Greenwich in the evening: at 20:29 on the 13th in Los Angeles an agent was told a decision was made on the 14th, and
// remarked on it (a real session, 2026-11-13). A commit's own date (rank.mjs) is not a record's and is left as git has it.
export function localDay(at) {
  const s = String(at || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;   // already a day: reading it as an instant would move it
  const d = new Date(s);
  if (!s || Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// A minute as a person reads it on this machine: the local day and time, and the zone's short name. align said the
// session's start in UTC (queue row Q51, seen in the 0.2.5 rehearsal).
export function localMinute(at) {
  const d = new Date(String(at || ''));
  if (Number.isNaN(d.getTime())) return String(at || '').replace('T', ' ').slice(0, 16);
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
  } catch { return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`; }
}

