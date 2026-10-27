import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { CASES, gradeResponse, buildTrial, claudeArgs, claudeEnv, envelopeResult, suiteHash, summarize, sourceHashes, runTrial } from './harness-eval.mjs';

test('exact deterministic grading rejects invalid JSON, unexpected fields and wrong values', () => {
  const expected = CASES[0].expected;
  assert.equal(gradeResponse(JSON.stringify(expected), expected).pass, true);
  assert.equal(gradeResponse('```json\n{}\n```', expected).reason, 'invalid-json');
  for (const value of [null, [], 'text', { ...expected, explanation: 'extra' }, { status: expected.status }, { ...expected, status: 42 }]) assert.equal(gradeResponse(JSON.stringify(value), expected).reason, 'invalid-fields');
  assert.equal(gradeResponse(JSON.stringify({ status: 'confirmed', action: 'refresh_source' }), expected).reason, 'wrong-values');
});

test('all fixtures have distinct IDs and valid deterministic expected responses', () => {
  assert.equal(CASES.length, 6);
  assert.equal(new Set(CASES.map(testCase => testCase.id)).size, CASES.length);
  for (const testCase of CASES) assert.equal(gradeResponse(JSON.stringify(testCase.expected), testCase.expected).pass, true);
  assert.match(suiteHash(), /^[a-f0-9]{64}$/);
  assert.equal(suiteHash(), suiteHash());
});

test('arms share facts/schema; only treatment adds policy and selected effort', () => {
  for (const testCase of CASES) {
    const baseline = buildTrial(testCase, 'baseline');
    const treatment = buildTrial(testCase, 'treatment');
    assert.ok(baseline.prompt.includes(testCase.task));
    assert.ok(treatment.prompt.includes(testCase.task));
    assert.equal(baseline.effort, 'medium');
    assert.doesNotMatch(baseline.prompt, /TASK REASONING POLICY/);
    assert.match(treatment.prompt, /TASK REASONING POLICY/);
    assert.equal(baseline.prompt.split('\n\n').at(-1), treatment.prompt.split('\n\n').at(-1));
  }
});

test('Claude invocation isolates tools, connectors, user settings and hooks', () => {
  const args = claudeArgs({ model: 'test-model', effort: 'medium' });
  const flag = name => args[args.indexOf(name) + 1];
  assert.equal(args[0], '-p');
  assert.equal(flag('--output-format'), 'json');
  assert.equal(flag('--tools'), '');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--effort'), 'medium');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(!args.some(arg => /bypassPermissions|dangerously/i.test(arg)));
  const env = claudeEnv({ ANTHROPIC_API_KEY: 'k', PATH: '/bin' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.HARNESS_CHILD, '1');
  assert.equal(envelopeResult(JSON.stringify({ is_error: false, result: ' {"a":1} ' })), '{"a":1}');
  assert.equal(envelopeResult(JSON.stringify({ is_error: true, result: 'x' })), '');
  assert.equal(envelopeResult('garbage'), '');
});

test('ties and regressions cannot claim measured quality improvement', () => {
  const trial = { pass: true, latencyMs: 100 };
  const tied = summarize([{ ...trial, arm: 'baseline' }, { ...trial, arm: 'treatment' }]);
  assert.equal(tied.passedDelta, 0);
  assert.match(tied.interpretation, /no measured accuracy improvement/);
  const failed = summarize([{ ...trial, arm: 'baseline' }, { ...trial, arm: 'treatment', pass: false }]);
  assert.equal(failed.passedDelta, -1);
  assert.match(failed.interpretation, /fewer/);
});

test('source hashes distinguish implementation versions from unchanged fixtures', () => {
  const hashes = sourceHashes();
  assert.deepEqual(Object.keys(hashes), ['harness-eval.mjs', 'reasoning-policy.mjs', 'model-routing.mjs']);
  for (const hash of Object.values(hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
});

test('cancellation kills a TERM-ignoring model group and removes its temporary directory', async () => {
  const controller = new AbortController();
  let child, cwd, ready;
  const started = new Promise(resolve => { ready = resolve; });
  const pending = runTrial(CASES[0], 'baseline', {
    model: 'fake', binary: 'unused', timeoutMs: 10000, signal: controller.signal,
    spawnProcess: (_binary, _args, options) => {
      cwd = options.cwd;
      child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.stderr.write("ready"); setInterval(()=>{},1000)'], options);
      child.stderr.once('data', ready);
      return child;
    },
  });
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.pass, false);
  assert.equal(fs.existsSync(cwd), false);
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
  assert.equal(summarize([result]).passedDelta, null);
});

test('already cancelled trials never launch a process', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runTrial(CASES[0], 'baseline', { model: 'fake', binary: 'unused', timeoutMs: 10000, signal: controller.signal, spawnProcess: () => { throw new Error('Must not spawn'); } });
  assert.equal(result.cancelled, true);
  assert.equal(result.pass, false);
});
