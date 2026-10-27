# Multi-harness RL + q-agent-harness: what applies to a personal Claude Code harness

Date: 2026-10-26. Sources read in full: the FineEnvs article "The ultimate guide to multi-harness RL" (huggingface.co/spaces/FineEnvs/multi-harness-rl, chapter files in the Space repo, updated 2026-10-01) and github.com/kju4q/q-agent-harness (cloned at HEAD 2026-10-26). Cited third-party papers were not independently fetched; their numbers are as reported by these two sources.

## 1. Facts worth keeping

**The harness moves the score as much as the model.** Same weights, different harness: LFM2.5-2.6B solved 62% under Mini-SWE-Agent vs 33% under Claude Code before training. GLM-5.2 on SWE-bench Pro: 23% vs 52% by harness. A cited study: swapping harness moved GLM-5.1 by 13 points, swapping the model inside one harness moved it only 2.5–5. Claude Opus 4.5: 45.9% (SEAL scaffold) vs 55.4% inside Claude Code.

**Overfitting to one harness is real.** Training only in OpenCode raised OpenCode 34→58% but helped less elsewhere; training across four harnesses won under Claude Code (49 vs 42) and Codex (54 vs 43). Overall difference (54.2 vs 52.3) was within noise, one seed. Three overfit modes: action format, context structure, control flow.

**Rewarding activity instead of outcomes collapses performance.** A "+0.2 for submitting anything" term made the policy submit immediately: held-out accuracy fell 0.740 → 0.178 while the training reward looked healthy. A failed sandbox was scored `None` (unknown), never as a wrong answer.

**Finish, and stay short.** Without an efficiency term, Qwen's tool calls per rollout doubled (~10→20), its submit rate fell 69%→41%, and its answers grew into the 4,096-token cap (truncated cells went from 9 to 556 of 1,000). A small bonus (≤0.1, only on correct answers) for fewer tool calls cut calls 31% with no accuracy loss.

**A bigger harness costs more and doesn't reliably score more** (from the q-agent-harness `harness-tax.md` citations: HarnessTax/Arena 2026-09-16, Liu & Han arXiv 2610.04433, Lehmann & Vahdati arXiv 2610.30499). Claude Code's fixed preamble is about 16.6k tokens vs 829 for mini-SWE-agent, with similar success. Self-rewritten harnesses gained +2.80 with a 95% CI of [-1.44, 7.35], which could be zero.

**Edited harnesses can beat model upgrades** (Google Harness², arXiv 2610.14224 as cited): GLM-5 in OpenCode went from 64.2 to 75.7 through harness file edits alone. The loop is *propose → run → compare → keep → log*. A lesson is kept only when side-by-side runs back it.

## 2. Principles distilled from q-agent-harness

- **Map, guardrails, feedback loops.** If the agent can't find context, it guesses. Without boundaries, it takes risky moves. If it can't see failure, it can't fix it.
- **Memory tiers:** hot (always loaded, under 2k tokens), episodic (what happened), semantic (how the system works), procedural (skills). Lessons move up: *episodic → procedural → hot*. The trigger is three repetitions: a one-sentence fix becomes a hot rule, a multi-step fix becomes a procedure.
- **Curate, don't accumulate.** The always-loaded file is an index, not an archive. Hermes caps MEMORY.md at about 2,200 characters, and the cap is what forces curation.
- **Order of trust:** tests and golden examples are the gate, an external fresh-context reviewer is the judge, and self-critique is only a first draft of doubt. A loop stops when the required checks pass, not when the model feels confident.
- **Task setups:** debugging needs hypotheses, research needs sources, decisions need criteria.
- **Edit-loop rules:** every proposed edit must quote the line in the real output it would have fixed. Apply one edit per run. A fresh-context judge compares against the definition of done and ignores length. A tie means remove the edit. A barely-winning edit gets a second run ("twice is a result, once is weather"). Log losing edits too. The file should end the same length or shorter.
- **Procedures** carry a version, a validation date, when to use (and when not), steps, and observable done conditions. A procedure not run in six months is a guess.

## 3. Mapping to the author's system (status as of 2026-10-26)

| Idea | Already in place | Gap closed today |
|---|---|---|
| Baseline vs candidate eval | `harness-eval.mjs`, `harness-evidence.mjs`, `harness-improvement` skill | Edit-loop rules added to the skill |
| Order of trust | Contract: "distinguish prepared/executed/verified" | Stated explicitly in the skill |
| Harness tax | none | `scripts/harness-tax.mjs` audit; first run below |
| Index-not-archive memory | MEMORY.md had grown to an archive (~4.1k tokens) | Rewritten to one-line hooks; backup kept |
| Activity-reward trap | Job-application and outreach loops reported counts | Audit question added: grade loops on verified outcomes, unknown ≠ fail |
| Harness portability | One operating contract rendered for Claude Code + Codex | Keep skills plain-markdown and harness-neutral |

### First harness-tax run (2026-10-26, before fixes)

- Always-loaded instruction + memory files: about 5.5k tokens (CLAUDE.md 1.2k, AGENTS.md 0.16k, MEMORY.md 4.1k), against a 2k budget.
- Skills: 180 local skill files with about 21k listing tokens, about 45 with any trace of use in 30 days (an upper bound). The zero-use plugins were social-media-skills (17), legal (9), finance (8) and ui-ux-pro-max. marketing-skills had 5 of 49 used for about 8.6k tokens. On top of this come the claude.ai-synced skills (sales, small-business, zoom, operations, HR, data…) and MCP server instructions; Higgsfield's instructions alone are long. Disabling plugins is the owner's call (`/plugin`, plus claude.ai/customize/skills for synced ones).

## 4. Questions to ask of any agent loop (from the RL reward lessons)

1. Is the loop scored on a verified outcome, or on activity (sends, submissions, drafts)? Activity is Goodhart bait.
2. Does an infrastructure failure get recorded as *unknown* rather than as a failure, or worse, as a success?
3. Is there a stop condition tied to a check, and an output cap that matches what the consumer reads?
4. Are tool calls or turns per success trending up? That's the non-finishing signal.
