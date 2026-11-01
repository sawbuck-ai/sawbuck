import { test } from 'node:test';
import assert from 'node:assert';
import { tally } from '../yank.mjs';

const L = (o) => JSON.stringify(o);
const asst = L({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
const user = (s) => L({ type: 'user', userType: 'external', message: { content: s } });
const toolres = L({ type: 'user', userType: 'external', message: { content: [{ type: 'tool_result', content: 'x' }] } });
const meta = L({ type: 'user', isMeta: true, message: { content: 'system reminder' } });

test('counts terse yanks after an agent turn, excludes the opener and approvals', () => {
  const text = [
    user('build the thing'),               // opener, not a yank
    asst,
    user('yes do it'),                      // approval, not a yank
    asst,
    user('no, use prefer-online'),          // YANK
    asst,
    user('actually stop, revert that'),     // YANK
  ].join('\n');
  const r = tally(text);
  assert.equal(r.turns, 4);
  assert.equal(r.yanks, 2);
  assert.ok(r.rate > 0.49 && r.rate < 0.51);
  assert.equal(r.recent.length, 2);
});

test('ignores tool_result, meta, and task-notification turns', () => {
  const text = [
    user('start'), asst, toolres, meta,
    L({ type: 'user', userType: 'external', message: { content: '<task-notification> <task-id>x</task-id> done' } }),
    asst, user("don't do that"),
  ].join('\n');
  const r = tally(text);
  assert.equal(r.turns, 2);   // 'start' (opener) + "don't do that"
  assert.equal(r.yanks, 1);
});

test('a yank requires a preceding agent action', () => {
  const text = [user('start'), user('no not like that')].join('\n'); // no assistant between
  const r = tally(text);
  assert.equal(r.yanks, 0);
});

test('empty / unparseable transcript is safe', () => {
  const r = tally('not json\n\n{bad');
  assert.equal(r.turns, 0);
  assert.equal(r.yanks, 0);
  assert.equal(r.rate, 0);
});
