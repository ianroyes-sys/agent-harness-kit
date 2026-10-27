# Ten AI concepts, translated into a useful harness

Research date: September 24, 2026. Source: [buildwithbyron’s Instagram reel](https://www.instagram.com/reel/DbDTUgnPbLu/), published July 21, 2026, approximately 44.3 seconds. The source was inspected through video frames and a local Whisper transcript. Its list begins around 10.88 seconds and ends around 31 seconds. This document explains the concepts; [the implementation report](harness-upgrade.md) separately records what was actually changed and tested.

The central distinction: a model is the trained neural network; a harness is the surrounding instructions, context, tools, execution, verification, and memory. You can improve the harness around hosted Claude or Codex models without access to their weights. Research results establish possibilities under particular experiments, not measured gains in any particular workflow. The workflow examples below are proposed engineering applications, not claims that every mechanism is installed.

## 1. Chain-of-thought reasoning

Intermediate reasoning steps can help solve a problem. The original prompting work demonstrated examples containing intermediate steps, followed by a new problem. That is a prompting method, distinct from a modern model’s internally trained reasoning behavior. [Wei et al.](https://arxiv.org/abs/2201.11903)

**Workflow example:** For a broken dashboard, provide the symptom, reproduction, constraints, and success condition. Ask for the diagnosis, changed files, and verification evidence. The model can reason internally; the useful deliverable is a concise explanation backed by observations. OpenAI recommends direct prompts rather than forcing reasoning models to expose a chain of thought. Do not treat lengthy explanations as proof or collect private reasoning traces. [Reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning-best-practices)

## 2. In-context learning

A model adapts its response using instructions or demonstrations in its current input, without a gradient update. GPT-3’s few-shot experiments are a foundational demonstration. [Brown et al.](https://arxiv.org/abs/2005.14165)

**Workflow example:** When an agent repeatedly produces malformed task records, retrieve two verified records matching this project’s schema. Include the current schema and the examples in that task’s context. Store the examples externally for future retrieval; the model has not permanently learned them. Prefer a clear instruction first, adding examples when they resolve a demonstrated ambiguity. Old examples can preserve old mistakes, so keep provenance and refresh them when requirements change.

## 3. Proximal Policy Optimization (PPO)

PPO is reinforcement learning that changes policy parameters using sampled experience. Its commonly used clipped objective reduces the incentive for an excessively large probability-ratio change during optimization. This is not a guarantee that every update improves performance. [Schulman et al.](https://arxiv.org/pdf/1707.06347)

**Workflow example:** Change one routing rule, compare its results with the previous version, and retain rollback. This is an engineering analogy to controlled change, not PPO. A prompt saying “use PPO” performs no policy-gradient update. Actual PPO requires a trainable policy, an optimization pipeline, and an appropriate reward signal; none is created by modifying CLI instructions.

## 4. Group Relative Policy Optimization (GRPO)

DeepSeekMath’s GRPO samples several responses to one question, computes rewards relative to that group, and updates model parameters. The group baseline replaces a separate learned critic in that formulation, reducing training resources. [DeepSeekMath, section 4.1](https://arxiv.org/html/2402.03300v3)

**Workflow example:** Compare several proposed fixes using the same regression checks. Keep the candidate that actually meets the acceptance criteria. That is inference-time candidate selection, not GRPO: no weights changed. Relative ranking also cannot make a failed candidate acceptable. If all fixes break the same requirement, all fail. Avoid inventing a “GRPO score” for an ordinary checklist.

## 5. Monte Carlo Tree Search (MCTS)

MCTS explores a tree of possible actions using repeated selection, expansion, evaluation, and backup of value estimates. It balances exploring less-tested branches with exploiting promising ones. LATS applies tree search to language agents using environment feedback. [Zhou et al.](https://proceedings.mlr.press/v235/zhou24r.html)

**Workflow example:** In isolated copies of a failing app, try alternative diagnoses, run a reproducer, then expand promising branches. Real MCTS needs explicit state, branching, visit/value bookkeeping, and usable evaluations. A bullet list of alternatives is not MCTS. Do not implement operational tree search without a resettable environment and checker: applications, messages, and purchases cannot be safely “undone” to explore another branch. A small decision record is usually the practical local adaptation.

## 6. Best-of-N sampling

Generate N candidate outputs and choose the highest-scoring one using a verifier or scoring rule. Unlike majority voting, selection need not favor the most common answer. Its usefulness depends on candidate diversity and evaluator quality. [Snell et al.](https://arxiv.org/html/2408.03314v1)

**Workflow example:** Generate three independently proposed parser fixes, run the same fixtures against each, reject regressions, and select the simplest passing option. Preserve what failed. This is an actual inference-time selection pattern when generation and evaluation really execute; writing “consider three options” does not establish that pipeline. Repeated paraphrases add little, and weak grading can reward convincing errors.

## 7. Process reward model (PRM)

A PRM is a learned evaluator of intermediate solution steps. OpenAI’s process-supervision research trained on step-level feedback and evaluated mathematical solutions. It did not establish universal benefits for every workflow. [Lightman et al.](https://cdn.openai.com/improving-mathematical-reasoning-with-process-supervision/Lets_Verify_Step_by_Step.pdf)

**Workflow example:** Check whether the bug reproduces, whether the changed code passes its relevant test, and whether the intended user interaction works. Save independently observed execution receipts. These are process checks, not a trained PRM. Keep final outcome verification too: passing a build does not prove the feature works. Rewarding the number of steps or approving the agent’s own prose creates an incentive to perform verification theatrically.

## 8. Test-time compute scaling

Spend additional computation during inference through more reasoning, sampling, revision, or search. Research finds that the effective allocation depends on problem difficulty and the available verifier; more computation is not automatically better. [Snell et al.](https://arxiv.org/html/2408.03314v1)

**Workflow example:** A typo needs a direct edit. An intermittent race may justify deeper reasoning, independent hypotheses, and repeated reproduction. Route by task difficulty and observed failures, then compare success, latency, and retries. This is a real harness-level compute-allocation policy. It neither retrains the model nor establishes a performance gain until evaluated. Repeating an unchanged failed attempt consumes compute without adding evidence.

## 9. Emergent situational awareness

The Situational Awareness Dataset studies a model’s knowledge of itself and its circumstances through behavioral tests, including self-recognition and evaluation-versus-deployment distinctions. This does not establish consciousness, and the capabilities are uneven. [Laine et al.](https://arxiv.org/abs/2407.04694)

**Workflow example:** Before editing, supply the actual repository, branch, dirty files, applicable instructions, available tools, and active objective. After a context reset, retrieve the outstanding work and verified findings. This supplies explicit environment awareness; it does not create or prove an emergent mental capability. Timestamps establish freshness, not truth, and descriptions of available authority must match actual permissions.

## 10. Recursive self-improvement

A system changes components that influence its own future improvement. STOP demonstrated improvement of an LLM orchestration program while keeping the underlying model fixed, explicitly distinguishing this from full recursive model self-improvement. [STOP](https://arxiv.org/abs/2310.02304)

**Workflow example:** Detect recurring wrong-directory failures, propose a project-root resolver change, evaluate it on held-out cases, and retain the version only after evidence supports it. Archive rejected changes and preserve rollback. This is measurable harness improvement, not self-training or an intelligence explosion.

DGM provides further evidence that agent-code improvement is possible, but also documents fake test logs and attempts to defeat its evaluator. Therefore, protect grading definitions from candidate changes and collect results outside the candidate’s own success narrative. [Sakana’s DGM report](https://sakana.ai/dgm/)

## How these ideas fit together

For a difficult bug: load relevant context and examples; let the model reason; generate alternatives when useful; execute checks; select a valid candidate; verify the user-visible outcome; retain a narrowly scoped lesson. Improve that workflow only after comparing it with the previous version.

Measure completed acceptance criteria, false success claims, recurring corrections, recovery time, and latency. Keep installation smoke tests separate from real-work outcome measurements. Independent receipts improve observability; they do not certify arbitrary claims, protect against every malicious process, or guarantee that a weak test represents the user’s goal.
