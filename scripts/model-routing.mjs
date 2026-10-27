// Explicit runtime mapping for the model tiers used in loop specs. Models run through local
// Claude Code headless (subscription login), so the tiers are Claude aliases themselves.
export const MODEL_ROUTES = Object.freeze({ haiku: "haiku", sonnet: "sonnet", opus: "opus" });
// Legacy non-Claude model ids recorded in older specs, state and receipts keep resolving.
export const LEGACY_MODEL_ROUTES = Object.freeze({
  "gpt-5.6-luna": "haiku", "gpt-5.6-terra": "sonnet", "gpt-5.6-sol": "opus", "gpt-6-astra": "opus", "gpt-6-sol": "opus",
});
const isClaudeModel = value => typeof value === "string" && (Object.hasOwn(MODEL_ROUTES, value) || /^claude-[a-z0-9.-]+$/i.test(value));

// Map any requested/recorded model to the Claude model the harness would actually run. Unknown gpt-* ids
// fall back to sonnet instead of being passed to a CLI that cannot serve them.
export function claudeModel(value, fallback = "sonnet") {
  const v = typeof value === "string" ? value.trim() : "";
  if (isClaudeModel(v)) return MODEL_ROUTES[v] || v;
  if (Object.hasOwn(LEGACY_MODEL_ROUTES, v)) return LEGACY_MODEL_ROUTES[v];
  return fallback;
}

export function resolveModel(requested = "sonnet", env = process.env) {
  // HARNESS_MODEL pins one model for an incident or experiment; stale gpt-* pins fall back.
  const resolved = claudeModel(requested || "sonnet");
  if (env?.HARNESS_MODEL) return claudeModel(env.HARNESS_MODEL, resolved);
  return resolved;
}
