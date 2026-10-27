#!/usr/bin/env node
// Execution evidence, not a task-completion judge or a security sandbox.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function outputCollector(limit) {
  const hash = createHash('sha256');
  let bytes = 0;
  let tail = Buffer.alloc(0);
  return {
    consume(chunk) {
      hash.update(chunk);
      bytes += chunk.length;
      if (limit) {
        tail = chunk.length >= limit
          ? Buffer.from(chunk.subarray(chunk.length - limit))
          : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.length - limit)), chunk]);
      }
    },
    result() {
      return {
        bytes, sha256: hash.digest('hex'), retainedBytes: tail.length,
        truncated: bytes > tail.length,
        ...(limit ? { tailBase64: tail.toString('base64') } : {}),
      };
    },
  };
}

/** maxOutputBytes is per stream; zero (default) retains no output text.
 * Commands are executed directly, with inherited environment and authority.
 * Timeout cleanup covers the POSIX process group, not descendants that detach.
 */
export async function runEvidenceCheck({ command, args = [], cwd = process.cwd(), timeoutMs = 120_000, maxOutputBytes = 0 }) {
  if (typeof command !== 'string' || !command || command.includes('\0')) throw new TypeError('command is required');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('args must be strings');
  integer(timeoutMs, 'timeoutMs', 1, 2_147_483_647);
  integer(maxOutputBytes, 'maxOutputBytes', 0, 1_048_576);
  const directory = await realpath(cwd);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stdout = outputCollector(maxOutputBytes);
  const stderr = outputCollector(maxOutputBytes);
  return new Promise(resolveReceipt => {
    const child = spawn(command, args, {
      cwd: directory, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let exitCode = null;
    let signal = null;
    let error = null;
    let closed = false;
    let escalationDone = false;
    let finalized = false;
    let outputComplete = true;
    let hardStop;
    const cleanupErrors = [];
    child.stdout.on('data', chunk => stdout.consume(chunk));
    child.stderr.on('data', chunk => stderr.consume(chunk));
    child.on('error', err => { error = { code: err.code || 'SPAWN_ERROR' }; });
    // Observe the exit event separately: descendants may keep output pipes open.
    child.on('exit', (code, sig) => { exitCode = code; signal = sig; });
    const killGroup = sig => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (err) {
        if (err.code !== 'ESRCH') cleanupErrors.push({ signal: sig, code: err.code || 'KILL_ERROR' });
      }
    };
    const finish = () => {
      if (finalized || !closed || (timedOut && !escalationDone)) return;
      finalized = true;
      clearTimeout(deadline);
      clearTimeout(hardStop);
      resolveReceipt({
        schemaVersion: 1, id: randomUUID(), evidenceType: 'process',
        scope: 'Only records whether this command exited zero; does not establish task completion.',
        command, args: [...args], cwd: directory, startedAt,
        finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
        timeoutMs, exitCode, signal, timedOut, error, outputComplete, cleanupErrors,
        success: exitCode === 0 && !signal && !timedOut && !error && outputComplete,
        stdout: stdout.result(), stderr: stderr.result(),
      });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Do not cancel escalation when the parent closes: its children may survive TERM.
      setTimeout(() => {
        killGroup('SIGKILL');
        escalationDone = true;
        finish();
        if (!finalized) {
          hardStop = setTimeout(() => {
            outputComplete = false;
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            closed = true;
            finish();
          }, 1_000);
        }
      }, 250);
    }, timeoutMs);
    child.on('close', (code, sig) => {
      // Spawn failures can emit close(-2), which is not an observed process exit.
      if (!error) { exitCode = code; signal = sig; }
      closed = true;
      finish();
    });
  });
}

async function main(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || !argv[separator + 1]) throw new Error('Usage: node scripts/harness-evidence.mjs [--timeout-ms N] [--max-output-bytes N] [--cwd PATH] [--receipt NEW_PATH] -- COMMAND [ARGS...]');
  const options = {};
  let receiptPath;
  for (let i = 0; i < separator; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (i + 1 >= separator) throw new Error(`Missing value for ${flag}`);
    if (flag === '--timeout-ms' || flag === '--max-output-bytes') {
      if (!/^\d+$/.test(value)) throw new Error(`Invalid integer for ${flag}`);
      options[flag === '--timeout-ms' ? 'timeoutMs' : 'maxOutputBytes'] = Number(value);
    } else if (flag === '--cwd') options.cwd = value;
    else if (flag === '--receipt') receiptPath = resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  // Reserve before execution: never rerun a check when its receipt already exists.
  const file = receiptPath ? await open(receiptPath, 'wx', 0o600) : null;
  try {
    const receipt = await runEvidenceCheck({ ...options, command: argv[separator + 1], args: argv.slice(separator + 2) });
    const json = `${JSON.stringify(receipt, null, 2)}\n`;
    if (file) {
      await file.writeFile(json);
      await file.sync();
      await file.chmod(0o400);
    }
    process.stdout.write(json);
    process.exitCode = receipt.success ? 0 : 1;
  } finally {
    await file?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    process.stderr.write(`${JSON.stringify({ error: err.code || err.message })}\n`);
    process.exitCode = 2;
  });
}
