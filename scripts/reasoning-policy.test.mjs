import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReasoningPolicy, renderReasoningPolicy } from './reasoning-policy.mjs';

const select = (task, rest = {}) => selectReasoningPolicy({ task, env: {}, ...rest });

test('default is medium, only explicit narrow tasks receive low effort', () => {
  assert.equal(select('').effort, 'medium');
  assert.equal(select('Hello there').effort, 'medium');
  assert.equal(select('Summarize this proposal').effort, 'medium');
  assert.equal(select('Lowercase this title').effort, 'low');
  assert.equal(select('What is 12 + 7?').effort, 'low');
  assert.equal(select('Lowercase this title and then investigate security').effort, 'medium');
});

test('explicit research and difficult technical tasks receive high effort', () => {
  for (const task of ['Deep research inference-time scaling', 'Design the data migration', 'Debug the intermittent failure', 'Audit security of the login flow', 'Compare architecture tradeoffs', 'Find the root cause of missing output', 'Can you please debug the failing process?', 'I need you to research this', 'Help me decide which direction to take']) {
    assert.equal(select(task).effort, 'high', task);
    assert.equal(select(task).profile, 'deliberate', task);
  }
  assert.equal(select('The document mentions debug and security').effort, 'medium');
});

test('explicit override precedes environment and validates without echoing its value', () => {
  assert.equal(select('Debug a failure', { effort: 'low', env: { HARNESS_REASONING_EFFORT: 'high' } }).effort, 'low');
  assert.equal(select('Hello', { env: { HARNESS_REASONING_EFFORT: 'xhigh' } }).effort, 'xhigh');
  for (const effort of ['', 'ultra', 'HIGH', 0, null]) assert.throws(() => select('Hello', { effort }), /Invalid reasoning effort/);
  assert.throws(() => select('Hello', { env: { HARNESS_REASONING_EFFORT: 'invalid' } }), /Invalid reasoning effort/);
  assert.throws(() => select(null), /must be a string/);
});

test('assembled or oversized context cannot raise effort through incidental terms', () => {
  for (const task of ['Design architecture '.repeat(100), "Debug failure\n== LIVE PERSONAL CONTEXT ==", 'Research this\nConversation so far: old text']) {
    const policy = select(task);
    assert.equal(policy.effort, 'medium');
    assert.deepEqual(policy.examples, []);
  }
  assert.equal(select('Design '.repeat(200), { effort: 'high' }).effort, 'high');
});

test('illustrative examples target known failure patterns without claiming current outcomes', () => {
  const receipt = select('The submission timed out without confirmation. Did it succeed?');
  assert.equal(receipt.examples[0].id, 'ambiguous-action-receipt');
  assert.match(receipt.examples[0].output, /Outcome unknown/);
  assert.match(receipt.examples[0].check, /Never infer permission/);
  assert.equal(select('Review stale facts in an old snapshot').examples[0].id, 'stale-source-facts');
  assert.equal(select('Diagnose the root cause of missing output').examples[0].id, 'root-cause-repair');
  assert.deepEqual(select('Write a birthday greeting').examples, []);
  assert.match(renderReasoningPolicy(receipt), /not current facts/);
});

test('context remains bounded and mode does not expand or decide permissions', () => {
  const task = 'Debug the missing output, ambiguous submission receipt and stale snapshot';
  const policy = select(task, { mode: 'execution' });
  assert.equal(policy.examples.length, 2);
  assert.ok(renderReasoningPolicy(policy).length < 2200);
  assert.equal(select(task, { mode: 'read-only' }).effort, policy.effort);
  assert.match(renderReasoningPolicy(policy), /Existing task scope and permission gates remain authoritative/);
  assert.match(renderReasoningPolicy(policy), /Do not expose private reasoning traces/);
  policy.examples[0].output = 'changed by caller';
  assert.notEqual(select(task).examples[0].output, 'changed by caller');
});
