// own-git.mjs: Sawbuck's own git calls run no hook, no fsmonitor command, and read no replace object, whatever the
// repo's or the person's git settings say. A turn set core.fsmonitor to a script of its own, and git ran the script
// inside the end-of-turn check's own `git status`: the judge ran code the judged had written (attack 11 of another
// session's second brief, 2026-11-21). Set through GIT_CONFIG_COUNT, which outranks every config file, in this process
// and the processes it starts. The engine is started with the person's environment (personEnv): it sets its own for
// its own git calls, and the commands it runs for the person (their tests) must see their git settings as they are.
const MARK = 'SAWBUCK_OWN_GIT';   // what was there before, for a process Sawbuck starts to find
export function ownGitOn(env = process.env) {
  if (env[MARK]) return;   // a process Sawbuck started: already on
  const k = Number(env.GIT_CONFIG_COUNT) || 0;
  const set = { GIT_CONFIG_COUNT: String(k + 2), [`GIT_CONFIG_KEY_${k}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${k}`]: '/dev/null', [`GIT_CONFIG_KEY_${k + 1}`]: 'core.fsmonitor', [`GIT_CONFIG_VALUE_${k + 1}`]: 'false', GIT_NO_REPLACE_OBJECTS: '1' };
  const was = Object.fromEntries(Object.keys(set).map((key) => [key, env[key] ?? null]));
  Object.assign(env, set, { [MARK]: JSON.stringify({ set, was }) });
}
// the environment for a process that runs the person's own commands: as they set it
export function personEnv(env = process.env) {
  const e = { ...env }; let m = null; try { m = JSON.parse(e[MARK] || 'null'); } catch { /* not ours */ }
  delete e[MARK];
  if (m && m.set && m.was) for (const [key, v] of Object.entries(m.set)) if (e[key] === v) { if (m.was[key] == null) delete e[key]; else e[key] = m.was[key]; }
  return e;
}
