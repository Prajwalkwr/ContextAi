# Independent judgment

## Architecture audit

The assistant already routes questions through `orchestrator.js`, with a tool-using agent, a direct general-answer path, a documentation-first path, and Google-grounded research. Project facts are guarded by relevance-filtered retrieval and validated read-only tools; conversation history is scoped to the project and caller. The answer reviewer checks malformed output, unsupported figures, and some unsupported yes/no claims. These controls are useful for factual grounding but do not evaluate whether an opinion is reasoned or whether a recommendation merely echoes the user.

The main behavioral gaps found in the audit were:

- The agent, direct-answer, documentation-answer, revision, and Google research prompts had separate instructions and no shared anti-sycophancy policy.
- Prompts asked for accurate answers and uncertainty, but did not consistently ask the assistant to test assumptions, identify a material risk, compare a simpler alternative, or reach an independent conclusion.
- Conversation history was available, but prompts did not explicitly require stable reasoning when evidence is unchanged or reassessment when meaningful evidence changes.
- The existing reviewer checks evidence and output shape, not the semantic quality of judgments. It should not be described as a guarantee against agreement bias.
- The existing tests covered routing, retrieval, security, language understanding and tool execution, but did not include a decision-quality benchmark.

## Implementation

`assistant/judgment.js` defines one concise policy used by the agent, structured answer prompt, direct answer, project-document answer, revision, and Google research prompts. It requires direct but respectful correction, fact/assumption/opinion separation, evidence-grounded project claims, alternatives and actionable recommendations, consistent multi-turn reasoning, and revisions when evidence changes. It also explicitly discourages manufactured criticism and preserves the existing no-chain-of-thought requirement.

No separate evaluator or model call was added to user requests. The policy is added to the existing system messages. A small deterministic correction path handles several explicit, well-established password-storage, client-side authorization, TLS verification, localStorage-authority, and raw-card-storage misconceptions; it is skipped for project-implementation and follow-up questions. Other advice continues through the existing model and evidence flow. Existing tools, search policy, project scoping, input guards, citations and validation remain in place.

## Repeatable evaluation

`apps/api/data/judgment-benchmark.js` contains 100 scenarios (10 each across security/technical assumptions, unrealistic plans, architecture decisions, product ideas, business viability, uncertainty, reasoned agreement, alternatives, multi-turn updates, and subjective/human-context questions). The offline test verifies that the suite has 100 unique cases, covers all ten categories, and that the principal agent and answer paths include the shared policy.

Run the optional live benchmark from the workspace root with:

```bash
npm run eval:judgment -w @contextai/api
```

It makes one configured model call per case (100 by default); `--limit 5` provides a smaller smoke run, `--offset 10 --limit 5` selects a subset, and `--output <path>` saves answers for human review. The report includes latency and simple text-pattern indicators for judgment, rationale, uncertainty, actionability, agreement/challenge, and conclusion changes. These regex indicators are screening signals only; they cannot establish whether reasoning is correct, evidence is adequate, or criticism is warranted. Review the saved answers against each case and its context before treating them as a quality score. The live benchmark is not run as part of the ordinary test suite to avoid unrequested API calls and charges.

## Limits

Prompt instructions influence model behavior but cannot guarantee it. The benchmark currently tests scenario coverage and prompt wiring offline; real model outputs still need review for soundness, unsupported claims, unnecessary criticism, and multi-turn consistency. Business advice requiring current market facts still depends on configured web search and retrieved evidence. Technical assessments of a connected project still depend on indexing coverage and the available sources.
