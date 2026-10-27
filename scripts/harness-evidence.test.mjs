import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runEvidenceCheck } from './harness-evidence.mjs';

const run = (source, options = {}) => runEvidenceCheck({ command: process.execPath, args: ['-e', source], timeoutMs: 5_000, ...options });
const cli = fileURLToPath(new URL('./harness-evidence.mjs', import.meta.url));

test('a real zero exit records process evidence, hashes and no output text by default', async () => {
  const receipt = await run('console.log("secret test output")');
  assert.equal(receipt.success, true);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.evidenceType, 'process');
  assert.equal(receipt.stdout.sha256, createHash('sha256').update('secret test output\n').digest('hex'));
  assert.equal(receipt.stdout.retainedBytes, 0);
  assert.equal('tailBase64' in receipt.stdout, false);
  assert.ok(receipt.durationMs >= 0);
  assert.match(receipt.scope, /does not establish task completion/);
});

test('printed PASS cannot override a failed process', async () => {
  const receipt = await run('console.log("PASS"); process.exit(1)');
  assert.equal(receipt.success, false);
  assert.equal(receipt.exitCode, 1);
});

test('unknown executable produces a failed receipt, not a fictitious exit status', async () => {
  const receipt = await runEvidenceCheck({ command: '/no-such-harness-command', timeoutMs: 1_000 });
  assert.equal(receipt.success, false);
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.error.code, 'ENOENT');
});

test('timeout defeats even a graceful zero exit after TERM', async () => {
  const receipt = await run('process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},100)', { timeoutMs: 400 });
  assert.equal(receipt.timedOut, true);
  assert.equal(receipt.success, false);
  assert.ok(receipt.durationMs < 3_000);
});

test('output retention is bounded while hashes cover all bytes', async () => {
  const receipt = await run('process.stdout.write("x".repeat(200000)); process.stderr.write("last-error")', { maxOutputBytes: 16 });
  assert.equal(receipt.success, true);
  assert.equal(receipt.stdout.bytes, 200000);
  assert.equal(receipt.stdout.retainedBytes, 16);
  assert.equal(Buffer.from(receipt.stdout.tailBase64, 'base64').toString(), 'x'.repeat(16));
  assert.equal(receipt.stdout.sha256, createHash('sha256').update('x'.repeat(200000)).digest('hex'));
  assert.equal(receipt.stderr.bytes, 10);
  assert.equal(receipt.stdout.truncated, true);
});

test('invalid limits fail before execution', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.2, 2_147_483_648]) {
    await assert.rejects(run('', { timeoutMs }), /timeoutMs/);
  }
  await assert.rejects(run('', { maxOutputBytes: -1 }), /maxOutputBytes/);
});

test('CLI creates private read-only receipt and rejects overwrite before running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-evidence-test-'));
  try {
    const path = join(directory, 'receipt.json');
    const first = spawnSync(process.execPath, [cli, '--receipt', path, '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const original = await readFile(path, 'utf8');
    assert.equal(JSON.parse(original).success, true);
    assert.equal((await stat(path)).mode & 0o777, 0o400);
    const second = spawnSync(process.execPath, [cli, '--receipt', path, '--', process.execPath, '-e', 'console.error("SHOULD_NOT_RUN")'], { encoding: 'utf8' });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /EEXIST/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI propagates failure and does not interpolate shell arguments', () => {
  const failed = spawnSync(process.execPath, [cli, '--', process.execPath, '-e', 'console.log("PASS"); process.exit(9)'], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).exitCode, 9);
  const literal = '$(echo SHELL_EXPANSION); `echo OTHER`';
  const receipt = spawnSync(process.execPath, [cli, '--max-output-bytes', '200', '--', process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal], { encoding: 'utf8' });
  assert.equal(receipt.status, 0);
  assert.equal(Buffer.from(JSON.parse(receipt.stdout).stdout.tailBase64, 'base64').toString(), literal);
});

test('timeout kills TERM-ignoring descendants even after parent exits', { skip: process.platform === 'win32' }, async () => {
  const source = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log(process.pid); setInterval(()=>{},100)'], {stdio:['ignore','pipe','ignore']});
    child.stdout.on('data', data => process.stdout.write(data));
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{},100);
  `;
  const receipt = await run(source, { timeoutMs: 500, maxOutputBytes: 100 });
  const pid = Number(Buffer.from(receipt.stdout.tailBase64, 'base64').toString().trim());
  assert.ok(pid > 1);
  assert.equal(receipt.timedOut, true);
  assert.equal(receipt.success, false);
  // KILL delivery and reaping can lag slightly behind the group signal.
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); } catch (err) { assert.equal(err.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Descendant ${pid} survived process-group timeout cleanup`);
});
