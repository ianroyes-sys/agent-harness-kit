#!/usr/bin/env node
// Local Claude Code headless adapter. Reasoning surfaces are read-only; execution is explicit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildContext, renderContext, contextDir, MARKER } from "./context-pack.mjs";
import { resolveModel } from "./model-routing.mjs";
import { selectReasoningPolicy, renderReasoningPolicy } from "./reasoning-policy.mjs";
import { compareCandidates, validateCandidates } from "./candidate-selection.mjs";

export const READ_ONLY_TOOLS = "Read,Grep,Glob";
export const EXECUTE_TOOLS = "Read,Grep,Glob,Edit,Write,Bash";
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
export const claudeBinary = (env = process.env) => env.HARNESS_CLAUDE_BIN || path.join(os.homedir(), ".local/bin/claude");
// Every call: no user/project settings (hooks such as SessionEnd capture never fire), zero MCP servers,
// no prompting (anything not pre-allowed is denied), no persisted session.
export const isolationArgs = () => ["--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG, "--setting-sources", "", "--no-session-persistence"];
// Child environment: subscription login only (an inherited API key would silently switch to paid
// API billing). HARNESS_CHILD=1 lets your own SessionEnd/capture hooks skip these headless runs.
export function claudeEnv(env = process.env) {
  const child = { ...env, HARNESS_CHILD: "1", PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${env.PATH || "/usr/bin:/bin"}` };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete child[key];
  return child;
}
// OS sandbox for Bash in the execute profile: writes only inside the declared roots, no network.
// File edits are pre-approved only inside the same roots ("//" prefix = absolute-path rule); kept in
// settings JSON rather than --allowedTools so roots containing spaces are never re-split.
export function sandboxSettings(roots) {
  const edits = roots.flatMap(dir => [`Edit(/${path.join(dir, "**")})`, `Write(/${path.join(dir, "**")})`]);
  return { permissions: { allow: ["Read", "Grep", "Glob", "Bash", ...edits], deny: ["WebFetch", "WebSearch"] }, sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: [...roots] }, network: { allowedDomains: [] } } };
}
// Parse the --output-format json envelope; only a non-error, non-empty final result counts.
export function parseClaudeEnvelope(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: false, error: "Agent exited without a final response. No completion inferred." };
  let envelope;
  try { envelope = JSON.parse(text); } catch {
    try { envelope = JSON.parse(text.split("\n").filter(Boolean).at(-1)); } catch { return { ok: false, error: "Agent returned an unreadable response envelope. No completion inferred." }; }
  }
  if (!envelope || typeof envelope !== "object") return { ok: false, error: "Agent returned an invalid response envelope. No completion inferred." };
  if (envelope.is_error) return { ok: false, error: `Agent reported an error (${String(envelope.subtype || "error")}): ${String(envelope.result || "").slice(0, 2000)}`, envelope };
  const result = typeof envelope.result === "string" ? envelope.result.trim() : "";
  if (!result) return { ok: false, error: "Agent exited without a final response. No completion inferred.", envelope };
  return { ok: true, result, envelope };
}

export function agentInvocation(argv, env = process.env) {
  const value = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const prompt = value("-p") || "";
  if (!prompt.trim()) throw new Error("Missing agent prompt.");
  // Legacy callers request execution with --permission-mode bypassPermissions; it is never forwarded.
  const readOnly = argv.includes("--read-only") || argv.includes("--allowedTools") || (!argv.includes("--execute") && value("--permission-mode") !== "bypassPermissions");
  const root = env.HARNESS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cwd = value("--cwd") || env.HARNESS_AGENT_CWD || process.cwd();
  const model = resolveModel(value("--model") || "sonnet", env);
  // Classify the original task, not retrieved notes, history, or injected instructions.
  const task = value("--task") ?? (prompt.length <= 2000 && !prompt.includes(MARKER) ? prompt : "");
  const reasoning = selectReasoningPolicy({ task, mode: readOnly ? 'read-only' : 'execute', effort: value('--effort'), env });
  const candidates = validateCandidates(value('--candidates') ?? '1', readOnly);
  // Existing one-shot callers retain their own deadlines, including long overnight work.
  const timeoutMs = Number(value('--timeout-ms') ?? (candidates > 1 ? 260000 : 0));
  if (!Number.isInteger(timeoutMs) || (timeoutMs !== 0 && timeoutMs < 100) || timeoutMs > 3600000) throw new Error('Timeout must be zero (caller managed) or 100–3600000 milliseconds.');
  const args = ["-p", "--output-format", "json", "--model", model, "--effort", reasoning.effort, ...isolationArgs()];
  let writableRoots = [];
  if (readOnly) {
    // Read/search only: no shell, no file edits, no web, no connectors.
    args.push("--tools", READ_ONLY_TOOLS, "--allowedTools", READ_ONLY_TOOLS);
  } else {
    const profile = value('--execution-profile') || 'workspace';
    if (profile !== 'workspace') throw new Error('Unsupported execution profile. Use an existing explicitly authorized external-action lane for host/browser/mail capabilities; sandbox failures never escalate automatically.');
    const additionalRoots = argv.flatMap((arg, i) => arg === '--add-dir' ? [argv[i + 1]] : []);
    writableRoots = [...new Set([cwd, root, ...additionalRoots])];
    for (const writable of writableRoots) {
      if (!writable || !path.isAbsolute(writable)) throw new Error('Execution writable roots must be explicit absolute paths');
    }
    // Bash runs in the OS sandbox (declared roots writable, network denied) and is never unsandboxed;
    // Edit/Write are allowed only inside the same roots. Nothing else can be approved (dontAsk).
    args.push("--tools", EXECUTE_TOOLS, "--settings", JSON.stringify(sandboxSettings(writableRoots)));
    for (const writable of writableRoots) args.push("--add-dir", writable);
  }
  return { prompt, task, root, cwd, model, readOnly, executionProfile: readOnly ? "read-only" : (value("--execution-profile") || "workspace"), args, writableRoots, reasoning, candidates, timeoutMs, rubric: value('--rubric') || '' };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-agent-"));
  let child;
  let escalation;
  let cancelled = false;
  let deadlineTimer;
  let timedOut = false;
  const signalChild = signal => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  };
  const stop = () => {
    cancelled = true;
    signalChild("SIGTERM");
    escalation = setTimeout(() => signalChild("SIGKILL"), 1500);
    escalation.unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    // Connectivity verification is deliberately synthetic: no context reads, user text, or tools.
    const selfTest = process.argv.includes("--self-test");
    const argv = selfTest ? ["-p", "Do not use tools. Reply with exactly AGENT_READY.", "--model", "haiku", "--read-only", "--effort", "low", "--timeout-ms", "60000"] : process.argv.slice(2);
    const invocation = agentInvocation(argv, selfTest ? { ...process.env, HARNESS_AGENT_CWD: dir, HARNESS_MODEL: "" } : process.env);
    if (argv.includes('--inspect')) {
      process.stdout.write(JSON.stringify({ model: invocation.model, cwd: invocation.cwd, mode: invocation.readOnly ? 'read-only' : 'execute', executionProfile: invocation.executionProfile, writableRoots: invocation.writableRoots, reasoning: invocation.reasoning, candidates: invocation.candidates, timeoutMs: invocation.timeoutMs }, null, 2));
      return;
    }
    if (selfTest) {
      // Zero tools for the synthetic check (an empty temporary working directory holds no project instructions).
      const args = invocation.args;
      args[args.indexOf("--tools") + 1] = "";
      args.splice(args.indexOf("--allowedTools"), 2);
    }
    // Pluggable context folder (HARNESS_CONTEXT_DIR); --no-context skips it for a single call.
    const packet = selfTest || process.argv.includes("--no-context") ? null : buildContext({ dir: contextDir(invocation.root) });
    const context = !packet || invocation.prompt.includes(MARKER) ? "" : renderContext(packet);
    const policy = invocation.readOnly
      ? "This is a read-only reasoning request. Explain or draft from evidence; do not perform external actions or claim that anything was executed."
      : "Execute only the requested task within the declared writable roots. This adapter has no configured host connectors and shell networking is disabled. If required browser/mailbox/network capabilities are unavailable, report the exact incomplete step and use an existing explicitly authorized lane; never bypass the sandbox or invent execution. Shared personal preferences never authorize new external actions. Preserve user work; verify concrete outcomes and report partial work honestly.";
    const environment = selfTest ? '' : `Runtime context: working directory ${invocation.cwd}; model ${invocation.model}; mode ${invocation.readOnly ? 'read-only' : 'scoped execution'}. Resolve project instructions and evidence from the actual task directory; do not assume a tool, source or successful previous action exists.`;
    const prompt = [policy, environment, selfTest ? '' : renderReasoningPolicy(invocation.reasoning), context, invocation.prompt].filter(Boolean).join("\n\n");
    if (invocation.timeoutMs) deadlineTimer = setTimeout(() => { timedOut = true; stop(); }, invocation.timeoutMs);
    const generate = async (input) => {
      if (cancelled) throw new Error(timedOut ? 'Shared reasoning deadline exceeded.' : 'Request cancelled.');
      // Each candidate is a separate process; a failed call cannot reuse a prior draft.
      let stderr = '';
      let stdout = '';
      let overflow = false;
      const exitCode = await new Promise((resolve, reject) => {
        child = spawn(claudeBinary(process.env), invocation.args, {
          cwd: invocation.cwd,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: claudeEnv(process.env),
        });
        child.stdout.on("data", chunk => { if (stdout.length < 50 * 1024 * 1024) stdout += chunk.toString(); else overflow = true; });
        child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
        child.stdin.on("error", () => {});
        child.once("error", reject);
        child.once("close", code => resolve(code ?? 1));
        child.stdin.end(input);
      });
      if (cancelled || exitCode !== 0) {
        const detail = parseClaudeEnvelope(stdout);
        throw new Error(`${timedOut ? 'Shared reasoning deadline exceeded' : 'Agent failed'} (${invocation.model}, exit ${exitCode}).\n${detail.envelope ? detail.error + '\n' : ''}${stderr}`);
      }
      if (overflow) throw new Error("Agent response exceeded the output limit. No completion inferred.");
      const parsed = parseClaudeEnvelope(stdout);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.result;
    };
    const result = invocation.candidates > 1
      ? (await compareCandidates({ prompt, count: invocation.candidates, generate, rubric: invocation.rubric })).text
      : await generate(prompt);
    process.stdout.write(result);
  } catch (error) {
    process.stderr.write(`agent: ${error.message}\n`);
    process.exitCode = timedOut ? 124 : cancelled ? 130 : 1;
  } finally {
    if (cancelled) signalChild("SIGKILL");
    clearTimeout(escalation);
    clearTimeout(deadlineTimer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
