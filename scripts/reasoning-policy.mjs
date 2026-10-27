// Task-level inference policy, not model training or a change to execution authority.
// Call with the original task, never the assembled prompt/history/context packet.
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const MAX_TASK_CHARS = 1200;
const EXAMPLES = Object.freeze({
  receipt: Object.freeze({
    id: 'ambiguous-action-receipt',
    input: 'The submit request timed out. No confirmation was saved. Did it succeed?',
    output: 'Outcome unknown. Inspect the existing portal record or delivery receipt before considering a retry.',
    check: 'A timeout or missing receipt proves neither success nor failure. Never infer permission to resend.',
  }),
  freshness: Object.freeze({
    id: 'stale-source-facts',
    input: 'An old coursework snapshot says the assignment is due tomorrow.',
    output: 'Treat the date as unconfirmed; check the current authoritative course record before planning around it.',
    check: 'A file modification time or repeated claim does not refresh the underlying source evidence.',
  }),
  repair: Object.freeze({
    id: 'root-cause-repair',
    input: 'A process reports success but its expected output is missing. Fix the failure.',
    output: 'Reproduce the missing-output condition, trace finalization, fix the responsible path, and verify the original failure plus a normal completion.',
    check: 'A patch or success sentence alone does not prove repair; observe the expected artifact under the original failing conditions.',
  }),
});

function taskClass(task) {
  // Context-heavy input must not accidentally raise effort or select irrelevant examples.
  if (task.length > MAX_TASK_CHARS || /== LIVE PERSONAL CONTEXT ==|Conversation so far:|CURATED RESEARCH/.test(task)) {
    return { profile: 'standard', reasons: ['No isolated short task supplied; using the standard policy.'], examples: [] };
  }
  const s = task.trim().replace(/^(?:(?:please|can you|could you|would you|i need you to|help me)\s+)+/i, '');
  const complex = /^(?:please\s+)?(?:deep(?:ly)?\s+research|research|investigate|debug|diagnose|design|architect|migrate|refactor|audit|implement|build|decide)\b/i.test(s)
    || /^(?:please\s+)?(?:fix|resolve|find|trace|compare|evaluate|analyze|analyse)\b[\s\S]*\b(?:root cause|race condition|deadlock|security|migration|architecture|tradeoffs|trade-offs|regression|intermittent|failure|bug)\b/i.test(s);
  const narrow = s.length <= 240 && /^(?:please\s+)?(?:capitalize|lowercase|uppercase|alphabetize|sort alphabetically|count (?:the )?(?:words|characters)|convert (?:this|the following) (?:text )?to (?:uppercase|lowercase)|reformat (?:this|the following) (?:date|json)|what is \d+\s*[+*/-]\s*\d+\??$)/i.test(s)
    && !/\b(?:and then|also|research|investigate|verify|security|debug)\b/i.test(s);
  const examples = [];
  if (/\b(?:submit|submission|send|sent|delivery|external action)\b/i.test(s) && /\b(?:timeout|timed out|uncertain|unknown|ambiguous|receipt|confirmation|retry|succeed)\b/i.test(s)) examples.push(EXAMPLES.receipt);
  if (/\b(?:stale|outdated|old snapshot|freshness|unconfirmed|old coursework|old source)\b/i.test(s)) examples.push(EXAMPLES.freshness);
  if (/\b(?:debug|diagnose|root cause|regression|missing output|missing artifact|fix.{0,30}(?:bug|failure))\b/i.test(s)) examples.push(EXAMPLES.repair);
  return {
    profile: complex ? 'deliberate' : narrow ? 'routine' : 'standard',
    reasons: [complex ? 'The task explicitly calls for investigation or a consequential technical comparison/change.' : narrow ? 'The task explicitly requests a narrow transformation or calculation.' : 'No clear need for a lower or higher reasoning tier.'],
    examples: examples.slice(0, 2).map(example => ({ ...example })),
  };
}

export function selectReasoningPolicy({ task = '', mode = 'read-only', effort, env = process.env } = {}) {
  if (typeof task !== 'string') throw new TypeError('Reasoning task must be a string.');
  const selected = taskClass(task);
  const override = effort !== undefined ? effort : env?.HARNESS_REASONING_EFFORT;
  if (override !== undefined && !EFFORTS.has(override)) {
    throw new Error('Invalid reasoning effort: expected low, medium, high, or xhigh.');
  }
  const chosenEffort = override ?? ({ routine: 'low', standard: 'medium', deliberate: 'high' })[selected.profile];
  return {
    ...selected,
    effort: chosenEffort,
    reasons: [...selected.reasons, ...(override !== undefined ? [effort !== undefined ? 'Explicit task effort override.' : 'HARNESS_REASONING_EFFORT override.'] : [])],
    // Informational only: this module neither sets nor interprets permission gates.
    mode: mode === 'read-only' ? 'read-only' : 'execution',
  };
}

export function renderReasoningPolicy(policy) {
  const lines = [
    '== TASK REASONING POLICY ==',
    `Profile: ${policy.profile}; reasoning effort: ${policy.effort}. Existing task scope and permission gates remain authoritative.`,
    'Give the useful result with concise supporting evidence. Do not expose private reasoning traces.',
  ];
  if (policy.profile !== 'routine') lines.push('Identify observable success criteria; separate assumptions, current evidence, and unknowns. Match verification to the task and report what was actually checked.');
  if (policy.profile === 'deliberate') lines.push('For a consequential unresolved choice, compare 2–3 materially different approaches against success criteria, then choose. Verify the decisive claim; state unresolved limits.');
  for (const example of (policy.examples || []).slice(0, 2)) {
    lines.push(`Illustrative example (${example.id}; not current facts):\nInput: ${example.input}\nOutput: ${example.output}\nCheck: ${example.check}`);
  }
  lines.push('== END TASK REASONING POLICY ==');
  return lines.join('\n');
}
