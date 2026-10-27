---
name: harness-improvement
description: Improve your AI harness or investigate repeated agent failures: task routing, execution receipts, baseline-versus-candidate evals, harness-tax audits of always-loaded context, and promoting repeated lessons into rules or skills. Use for workflow upgrades and recurring reliability problems, not every ordinary edit.
---

# Harness improvement

The tools live in this kit's `scripts/` folder. Below, `$KIT` is the absolute path to your checkout (for example `~/agent-harness-kit`). Run checks in the target project's real directory and read that project's instructions first. Existing task authority persists; these tools add no new outbound authority.

- For a concrete validation command, use `node $KIT/scripts/harness-evidence.mjs --cwd /absolute/project --receipt /new/receipt.json -- npm test`. Choose a new receipt path in an existing directory. The runner records real exit status, timeout and output hashes; no output text by default. Command arguments are recorded, so keep secrets out of arguments. A passing command establishes only what its checks cover. Do not rerun external actions as verification.
- For a difficult draft-only decision, use `node $KIT/scripts/agent.mjs --read-only --model opus --task 'original short request' -p 'request and relevant evidence' --candidates 2 --timeout-ms 260000`. This uses your normal Claude Code login and the context folder in `HARNESS_CONTEXT_DIR`. It samples independent drafts, then asks a model to select or reject them. Selection remains advisory. For ordinary tasks use one answer; candidate comparison rejects execution mode.
- `--inspect` on `agent.mjs` shows task routing without loading context or calling a model. `--effort low|medium|high|xhigh` overrides the inferred effort. Preserve explicit model choices. Do not classify a full retrieved-context packet as the user's task.
- For a proposed harness change, run `node $KIT/scripts/harness-eval.mjs` to inspect the fixed synthetic suite. `--live --output /new/report.json` compares baseline and treatment on the same model without personal context. Keep task definitions and graders fixed during the comparison. A tie is not a quality gain; add a separate held-out real failure before claiming general improvement.
- For context bloat, slow or forgetful sessions, or before adding anything always-loaded, run `node $KIT/scripts/harness-tax.mjs` (read-only; `--json`, `--days N`). Always-loaded rules plus the MEMORY.md index target 2k tokens or less. Anything loaded before you type must have been used in the last 30 days or earn its way back. Disabling plugins or synced skills is the owner's call; report the candidates with their token cost.

## The edit loop

For an instruction, skill or memory edit, run *propose → run → compare → keep → log*:

1. Baseline: rerun a real task that disappointed, unchanged, and save the output.
2. Propose edits that each quote the line of that output they would have fixed. An edit with no quoted line goes untested.
3. Apply one edit per fresh run, with the same task and prompt.
4. Compare in a fresh context (a subagent that never saw the work) against the definition of done. Length earns nothing; a cosmetic difference counts as a tie.
5. Keep only the winners. Remove ties and losses. A narrow win gets a second run before you keep it. The edited file ends the same length or shorter.
6. Log every edit, including losses, in the experiment record.

## Order of trust

Deterministic checks (tests, builds, receipts) and golden examples are the gate. A fresh-context reviewer is the judge. Self-critique is only a first draft of doubt. A loop stops when required checks pass, not when the model sounds confident. Grade loops on verified outcomes, never on activity counts (sends, submissions, drafts): rewarding activity made an RL policy submit instantly while held-out accuracy fell from 0.74 to 0.18. An infrastructure failure is *unknown*, not a failure or a success.

## Promotion

A lesson that repeats three times moves up. A one-sentence fix that applies to every task becomes a contract or CLAUDE.md rule. A multi-step fix becomes a skill or procedure with a version, a last-validated date, when to use (and not), and observable done conditions. A fact about a system goes to project memory. MEMORY.md stays an index of one-line hooks; details live in the linked file. When adding a rule, retire a stale one.

Keep a short experiment record: observed failure, candidate change, baseline, checks and limitations, outcome, and rollback. Promote a lesson only with evidence and project scope; a benchmark failure should become a regression case before changing the harness again. Preserve user edits when rolling back.

For concept distinctions and citations read `$KIT/docs/ai-harness-concepts.md` and `$KIT/docs/multi-harness-rl-and-q-agent-harness.md`. Operational notes and the first measured results are in `$KIT/docs/harness-upgrade.md`. This is inference orchestration and measured engineering, not PPO/GRPO training, a trained process reward model, or full recursive model self-improvement.
