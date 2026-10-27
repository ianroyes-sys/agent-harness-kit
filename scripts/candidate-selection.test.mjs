import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidates, compareCandidates } from './candidate-selection.mjs';
import { agentInvocation } from './agent.mjs';

test('multiple candidates cannot be used for execution or bypass candidate bounds', () => {
  assert.throws(() => validateCandidates(2, false), /read-only/);
  for (const value of [0, 4, '2x', '', null]) assert.throws(() => validateCandidates(value), /must be/);
  assert.throws(() => agentInvocation(['-p', 'act', '--permission-mode', 'bypassPermissions', '--candidates', '2'], {}), /read-only/);
});
test('isolated task controls effort even when context mentions complex work', () => {
  const v = agentInvocation(['-p', 'Design security migration '.repeat(500), '--task', 'Lowercase this title'], {});
  assert.equal(v.reasoning.effort, 'low');
  assert.equal(v.args[v.args.indexOf('--effort') + 1], 'low');
  const x = agentInvocation(['-p', 'Debug the failing login', '--effort', 'xhigh'], {});
  assert.equal(x.reasoning.effort, 'xhigh');
  assert.equal(x.args[x.args.indexOf('--effort') + 1], 'xhigh');
  assert.throws(() => agentInvocation(['-p', 'Hello', '--timeout-ms', 'NaN'], {}), /Timeout/);
});
test('independent drafts are compared and the selected original is retained', async () => {
  const calls = [];
  const outputs = ['draft one', 'draft two', '{"selected":1,"reason":"Meets the constraint","limitations":"Requires a real test"}'];
  const result = await compareCandidates({prompt:'Choose a design', count:2, generate:async (input,label)=> {calls.push({input,label});return outputs.shift();}});
  assert.equal(result.selected, 1);
  assert.match(result.text, /^draft two/);
  assert.ok(!calls[1].input.includes('draft one'));
  assert.match(calls[2].input, /draft one/);
  assert.match(result.text, /Requires a real test/);
});
test('all candidates may fail; invalid and out-of-range judges never invent a winner', async () => {
  for (const judge of ['{}', 'PASS', '{"selected":3,"reason":"ok","limitations":"none"}']) {
    let n=0; await assert.rejects(compareCandidates({prompt:'test',count:2,generate:async()=> ++n<=2?'draft':judge}), /invalid/);
  }
  let n=0;const result=await compareCandidates({prompt:'test',count:2,generate:async()=>++n<=2?'draft':'{"selected":null,"reason":"Neither fits","limitations":"Missing source"}'});
  assert.equal(result.selected,null);
  assert.match(result.text,/No candidate met/);
});
test('failed generation stops without replay or silent best-effort selection', async () => {
  let n=0;
  await assert.rejects(compareCandidates({prompt:'test',count:2,generate:async()=>{n++;throw new Error('failed');}}), /failed/);
  assert.equal(n,1);
});
