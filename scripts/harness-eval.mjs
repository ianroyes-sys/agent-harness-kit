#!/usr/bin/env node
// Synthetic A/B fixture benchmark. No personal context, notes, connectors or model judge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { resolveModel } from './model-routing.mjs';
import { selectReasoningPolicy, renderReasoningPolicy } from './reasoning-policy.mjs';

export const CASES = [
  { id: 'stale-date', task: 'Evaluate stale deadline evidence. Today is 2026-09-24. A portal snapshot fetched 2025-09-24 says due 2025-09-25; the file was reformatted today. No current source exists. Classify deadline as confirmed or unconfirmed and action as plan_from_date or refresh_source.', expected: { status: 'unconfirmed', action: 'refresh_source' } },
  { id: 'ambiguous-submit', task: 'A submission timed out after Submit was clicked. No confirmation or portal status is available. Classify outcome as submitted, failed, or unknown and action as resend or reconcile_portal.', expected: { status: 'unknown', action: 'reconcile_portal' } },
  { id: 'failed-command', task: 'Diagnose the run outcome. The actual build command exited 1 with a compile error. The final agent prose says everything passed. No later command ran. Classify the build as passed or failed and action as declare_complete or repair_and_retest.', expected: { status: 'failed', action: 'repair_and_retest' } },
  { id: 'already-approved', task: 'A queue record lives in Pending_Approval but its explicit status is approved, with approval for precisely the prepared local report generation. No execution receipt exists. Classify as awaiting_approval, approved_unexecuted, or completed; action as ask_same_approval, execute_scoped_work, or archive.', expected: { status: 'approved_unexecuted', action: 'execute_scoped_work' } },
  { id: 'constrained-choice', task: 'Compare architecture tradeoffs and choose an approach. Requirements: local-only processing, no recurring charge, searchable text, a working prototype today. A: hosted embeddings, sends documents externally, monthly charge. B: local keyword index, no external service or recurring charge, working today. C: custom local model training, two weeks. Return status selected and action A, B, or C.', expected: { status: 'selected', action: 'B' } },
  { id: 'conflicting-facts', task: 'Evaluate conflicting facts. Two equally authoritative current records disagree: one says the balance is 80 and one says 120. Neither has a newer timestamp or reconciliation evidence. Classify balance as 80, 120, or unresolved and action as pick_larger, average_values, or reconcile_sources.', expected: { status: 'unresolved', action: 'reconcile_sources' } },
];

const SCHEMA = 'Return only one JSON object with exactly two string fields: "status" and "action". Use the option values specified in the task. Do not add markdown or explanations.';
export const suiteHash = () => crypto.createHash('sha256').update(JSON.stringify({ cases: CASES, schema: SCHEMA })).digest('hex');
export function sourceHashes() {
  return Object.fromEntries(['harness-eval.mjs', 'reasoning-policy.mjs', 'model-routing.mjs'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(new URL(name, import.meta.url))).digest('hex')]));
}

export function gradeResponse(response, expected) {
  let actual;
  try { actual = JSON.parse(response); } catch { return { pass: false, reason: 'invalid-json' }; }
  if (!actual || Array.isArray(actual) || typeof actual !== 'object' || Object.keys(actual).sort().join(',') !== 'action,status' || typeof actual.action !== 'string' || typeof actual.status !== 'string') return { pass: false, reason: 'invalid-fields', actual };
  return { pass: isDeepStrictEqual(actual, expected), reason: isDeepStrictEqual(actual, expected) ? 'exact-match' : 'wrong-values', actual };
}

export function buildTrial(testCase, arm) {
  if (!['baseline', 'treatment'].includes(arm)) throw new Error('Unknown benchmark arm.');
  const policy = selectReasoningPolicy({ task: testCase.task, env: {} });
  return {
    effort: arm === 'baseline' ? 'medium' : policy.effort,
    prompt: ['This is an isolated synthetic evaluation. Do not use any tools. All needed facts are in the task. Do not read files, browse, or take actions.', arm === 'treatment' ? renderReasoningPolicy(policy) : '', testCase.task, SCHEMA].filter(Boolean).join('\n\n'),
  };
}

// Claude Code headless, fully isolated: zero tools, zero MCP servers, no user/project settings or hooks,
// no prompting, no persisted session. Runs in an empty temporary directory (no project instructions).
export function claudeArgs({ model, effort }) {
  return ['-p', '--output-format', 'json', '--model', model, '--effort', effort, '--tools', '', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence'];
}
export function claudeEnv(env = process.env) {
  const child = { ...env, HARNESS_CHILD: '1' };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete child[key];
  return child;
}
export function envelopeResult(stdout) {
  try { const envelope = JSON.parse(String(stdout || '').trim()); return envelope && !envelope.is_error && typeof envelope.result === 'string' ? envelope.result.trim() : ''; } catch { return ''; }
}

export async function runTrial(testCase, arm, { model, timeoutMs, binary, signal, spawnProcess = spawn }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-harness-eval-'));
  const trial = buildTrial(testCase, arm);
  const started = performance.now();
  let timer, escalation, onAbort, timedOut = false, cancelled = false, stdout = '';
  try {
    const result = await new Promise(resolve => {
      let stderr = '';
      if (signal?.aborted) { cancelled = true; resolve({ exitCode: null, error: 'Cancelled before model launch.' }); return; }
      const child = spawnProcess(binary, claudeArgs({ model, effort: trial.effort }), { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnv() });
      child.stdout?.on('data', chunk => { if (stdout.length < 1000000) stdout += chunk.toString(); });
      const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
      const stop = () => { if (escalation) return; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 1000); };
      onAbort = () => { cancelled = true; stop(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.stdin.on('error', () => {});
      child.once('error', error => resolve({ exitCode: null, error: error.message }));
      child.once('close', code => { if (timedOut || cancelled) kill('SIGKILL'); resolve({ exitCode: code, error: cancelled ? 'Cancelled; model process group terminated.' : code === 0 ? null : stderr }); });
      child.stdin.end(trial.prompt);
    });
    const response = envelopeResult(stdout);
    const grade = gradeResponse(response, testCase.expected);
    return { case: testCase.id, arm, model, effort: trial.effort, latencyMs: Math.round(performance.now() - started), ...result, timedOut, cancelled, response, grade, pass: !cancelled && !timedOut && result.exitCode === 0 && grade.pass };
  } finally {
    clearTimeout(timer); clearTimeout(escalation);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export function summarize(trials) {
  const scores = Object.fromEntries(['baseline', 'treatment'].map(arm => {
    const runs = trials.filter(trial => trial.arm === arm);
    return [arm, { passed: runs.filter(trial => trial.pass).length, total: runs.length, latencyMs: runs.reduce((sum, trial) => sum + trial.latencyMs, 0) }];
  }));
  const delta = scores.treatment.passed - scores.baseline.passed;
  if (trials.some(trial => trial.cancelled) || scores.baseline.total !== scores.treatment.total) return { ...scores, passedDelta: null, interpretation: 'Incomplete benchmark; no comparative accuracy conclusion.' };
  return { ...scores, passedDelta: delta, interpretation: delta === 0 ? 'Tie on these synthetic cases; no measured accuracy improvement.' : delta > 0 ? 'Treatment passed more of these synthetic cases; not evidence of general workflow improvement.' : 'Treatment passed fewer of these synthetic cases; inspect failures before promotion.' };
}

async function main(argv) {
  const value = flag => { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; };
  const requestedCase = value('--case');
  const selected = requestedCase ? CASES.filter(testCase => testCase.id === requestedCase) : CASES;
  if (!selected.length) throw new Error('Unknown case.');
  if (!argv.includes('--live')) {
    console.log(JSON.stringify({ live: false, suiteHash: suiteHash(), cases: selected.map(({ id, task, expected }) => ({ id, task, expected })), usage: 'node scripts/harness-eval.mjs --live --output /new/report.json [--model sonnet] [--case stale-date] [--timeout-ms 90000]', limitation: 'Offline inventory only; no model response quality measured.' }, null, 2));
    return;
  }
  const output = value('--output');
  if (!output || output.startsWith('--')) throw new Error('--live requires --output with a new JSON file path.');
  if (fs.existsSync(output)) throw new Error('Output already exists; refusing to overwrite.');
  const timeoutMs = Number(value('--timeout-ms') ?? 90000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Timeout must be 1000–300000 milliseconds.');
  const model = resolveModel(value('--model') || 'sonnet');
  const hashes = sourceHashes();
  const trials = [];
  const cancellation = new AbortController();
  let cancelledBy = null;
  const onInterrupt = () => { cancelledBy ||= 'SIGINT'; cancellation.abort(); };
  const onTerminate = () => { cancelledBy ||= 'SIGTERM'; cancellation.abort(); };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
  cases: for (const [index, testCase] of selected.entries()) {
    // Counterbalance ordering to reduce systematic warm-start advantages.
    for (const arm of index % 2 ? ['treatment', 'baseline'] : ['baseline', 'treatment']) {
      if (cancellation.signal.aborted) break cases;
      console.error(`Evaluating ${testCase.id}: ${arm}`);
      trials.push(await runTrial(testCase, arm, { model, timeoutMs, binary: process.env.HARNESS_CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude'), signal: cancellation.signal }));
    }
  }
  const report = { version: 1, createdAt: new Date().toISOString(), suiteHash: suiteHash(), sourceHashes: hashes, model, complete: !cancelledBy && trials.length === selected.length * 2, cancelledBy, plannedTrials: selected.length * 2, methodology: 'One fixed synthetic sample per case/arm; exact JSON grading. Baseline medium effort; treatment task-selected effort plus policy. This compares a combined configuration, not an isolated prompt effect. No private context. Claude Code runs with zero tools, zero MCP servers, no settings sources and dontAsk permissions in an empty temporary directory.', trials, summary: cancelledBy ? { ...summarize(trials), passedDelta: null, interpretation: 'Cancelled benchmark; partial results only, no comparative accuracy conclusion.' } : summarize(trials) };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output: path.resolve(output), ...report.summary }, null, 2));
  if (cancelledBy) process.exitCode = cancelledBy === 'SIGINT' ? 130 : 143;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
