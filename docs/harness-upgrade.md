# Harness upgrade notes (September 24, 2026)

These notes come from the release that introduced most of this kit inside the author's local agent dashboard. The ten concepts behind it are explained with primary sources in [ai-harness-concepts.md](ai-harness-concepts.md). The release applied the inference and engineering techniques that fit a real personal harness. Hosted model weights were not changed.

## What changed in daily use

| Surface | Before | After |
| --- | --- | --- |
| Conversation | One answer; the adapter did not set effort explicitly | The original request selects low/medium/high reasoning effort. Complex investigation and design get high; narrowly specified text transformations can use low. Unknown tasks keep medium. |
| Difficult decisions | No independent sampling or selection | **Compare two drafts** generates two independent drafts and a third model call selects one or rejects both. Results disclose that selection is advisory and which claims are unverified. Off by default. |
| Repeated failure patterns | Generic shared context | At most two relevant illustrative examples for ambiguous action receipts, stale facts, or root-cause repair. Examples are labeled as not current facts. |
| Command verification | Loop-specific checks, no reusable command receipt | `harness-evidence.mjs` records actual exit status, timeout, hashes, cwd and duration, with an optional exclusive receipt file. Printed success cannot overrule an exit failure. |
| Harness experiments | No focused baseline/candidate suite | Six fixed synthetic tasks, exact JSON grading, source and suite fingerprints, model/effort/latency recording, and honest partial results on interruption. |
| Future sessions | No entry point for these tools | A discoverable `harness-improvement` skill (see `skill/`). |

Multiple candidates are rejected in execution mode, so the comparison feature cannot multiply submissions or other side effects. Long one-shot jobs keep caller-managed deadlines.

## Using it

Record a check from any project's working directory:

```sh
node ~/agent-harness-kit/scripts/harness-evidence.mjs \
  --receipt /absolute/existing/directory/new-check.json -- npm test
```

Use a new receipt filename. No shell interpolation occurs. Output hashes and byte counts are kept by default; `--max-output-bytes 4000` adds bounded base64 output tails. Arguments are recorded, so keep secrets out of them. A zero exit validates the command only, not an entire feature. Receipts use exclusive creation and mode 0400; they are not signed or tamper-proof against the owning user. The runner inherits the caller's normal authority and is not a sandbox.

Inspect routing without a model call or context loading:

```sh
node scripts/agent.mjs -p 'Debug the intermittent failure' --inspect
```

`--task` supplies the original request separately from assembled context. `--effort` takes precedence over `HARNESS_REASONING_EFFORT`; both accept low/medium/high/xhigh. Explicit model overrides stay authoritative. Comparison accepts `--candidates 2` or `3`, a shared `--timeout-ms`, and an optional `--rubric`. It is read-only and does not auto-replay failures.

Inspect or run the synthetic benchmark:

```sh
npm run eval
npm run eval -- --live --model opus --output /absolute/new-report.json
```

Live evaluation runs Claude Code headless in empty temporary directories with zero tools, zero MCP servers, no settings sources and no personal context. Grade definitions stay outside the candidate's environment.

## Observed results and limits

- **Initial A/B evaluation:** baseline 6/6, treatment 6/6 on the six synthetic cases. Aggregate model-call time: baseline 27.7 s, treatment 33.6 s. That is a tie with extra latency, not an accuracy improvement. One sample per task is not a productivity study, and the treatment combines policy and effort, so their individual effects are not isolated. (This first run used the Codex CLI; the kit now runs on Claude Code.)
- **Live candidate comparison:** the real two-draft-and-judge pipeline completed on a synthetic local-versus-hosted decision in 35.5 s, with no personal context and no execution claims.
- **Regression tests** cover false PASS output, nonzero exit, missing executable, timeout despite graceful exit, bounded output, existing-receipt refusal, descendant termination, adapter isolation flags, missing or malformed model output, timeouts and candidate-selection failures.

The classifier is a conservative heuristic, not a learned difficulty predictor. Very long or already-assembled context defaults to medium rather than guessing. Multiple drafts are real best-of-N inference with a model judge, and the judge may be wrong. Nothing here implements trained PRMs, PPO, GRPO, full MCTS, emergent awareness, or recursive model self-training.

## Improvement cycle and rollback

For a recurring failure: keep its actual evidence, add a separate representative regression or held-out task, propose one scoped change, compare baseline and candidate, then keep the change only if the result justifies it. Keep graders fixed during a run. Preserve failed experiments; never teach a proposed lesson as an observed outcome.

To roll back: turn comparison off (one answer is the default) and set `HARNESS_REASONING_EFFORT=medium` to pin effort. A source rollback should reverse only the change under test and preserve concurrent work.
