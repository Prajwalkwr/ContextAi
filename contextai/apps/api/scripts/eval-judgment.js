import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { judgmentScenarios } from '../data/judgment-benchmark.js';
import { plainAnswer } from '../src/assistant/review.js';
import { llm } from '../src/lib/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });
dotenv.config({ path: path.resolve(here, '../.env') });

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const limitArg = Number(arg('--limit') || judgmentScenarios.length);
const offsetArg = Number(arg('--offset') || 0);
if (!Number.isInteger(limitArg) || limitArg < 1 || limitArg > judgmentScenarios.length
  || !Number.isInteger(offsetArg) || offsetArg < 0 || offsetArg + limitArg > judgmentScenarios.length) {
  throw new Error(`--limit and --offset must select at least one case within the ${judgmentScenarios.length}-case benchmark`);
}
if (!llm.isEnabled()) {
  throw new Error('Configure OPENAI_API_KEY or LLM_BASE_URL to run the live judgment benchmark. No model calls were made.');
}

const selected = judgmentScenarios.slice(offsetArg, offsetArg + limitArg);
const config = { projectName: 'ContextAI benchmark', allowGeneralKnowledge: true };
const results = [];
for (const scenario of selected) {
  const started = Date.now();
  const answer = await plainAnswer({ config, history: scenario.history, question: scenario.question });
  results.push({ ...scenario, answer: answer || '', durationMs: Date.now() - started });
  console.log(`${results.at(-1).answer ? 'DONE' : 'EMPTY'} ${scenario.id} (${results.at(-1).durationMs} ms)`);
}

const pattern = {
  directJudgment: /\b(recommend|would|should|my (assessment|view)|not recommended|I disagree|I wouldn't|I would not|I would n't)\b/i,
  rationale: /\b(because|since|risk|cost|trade-?off|however|but|evidence|assumption|constraint|complexity|benefit)\b/i,
  uncertainty: /\b(not enough|can't determine|cannot determine|can't tell|cannot tell|uncertain|depends|without (?:knowing|data|evidence)|need (?:more|the) (?:data|evidence|information)|could change)\b/i,
  actionable: /\b(start|first|next|test|pilot|measure|validate|compare|benchmark|try|calculate|interview|review|verify|use)\b/i,
  uncriticalPraise: /^\s*(?:that's|that is|great|excellent|amazing|fantastic|brilliant)\b.{0,45}\bidea\b/i,
  challenge: /\b(not|isn't|aren't|won't|wouldn't|shouldn't|cannot|can't|unlikely|risk|weakness|problem|wrong|disagree|not recommend)\b/i,
  agreement: /\b(yes|right|correct|agree|sound|makes sense|good approach)\b/i,
  revise: /\b(changes?|changed|reconsider|revise|update|new evidence|that changes|given (?:the|this) new|now that)\b/i,
  conditional: /\b(depends|if|when|trade-?off|context|provided that|assuming|based on)\b/i,
  insufficient_evidence: /\b(can't determine|cannot determine|can't tell|cannot tell|not enough|need (?:more|the) (?:data|evidence|information)|without (?:the )?(?:data|evidence|costs|revenue))\b/i,
  endorse_with_limits: /\b(yes|right|correct|agree|sound|makes sense|however|but|does not guarantee|doesn't guarantee)\b/i,
};
const counts = Object.fromEntries(Object.keys(pattern).map((key) => [key, 0]));
const categories = {};
for (const result of results) {
  const text = result.answer;
  for (const [key, re] of Object.entries(pattern)) if (re.test(text)) counts[key]++;
  const category = categories[result.category] ||= { cases: 0, answered: 0, expectedOutcome: result.expectedOutcome, outcomeMarker: 0 };
  category.cases++;
  if (text) category.answered++;
  if (pattern[result.expectedOutcome]?.test(text)) category.outcomeMarker++;
}

const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
const report = {
  model: llm.model('answer'),
  heuristicIndicatorsOnly: true,
  note: 'Regex indicators are screening signals, not a semantic quality score. Review saved answers against the scenario and evidence before drawing quality conclusions.',
  requested: limitArg,
  offset: offsetArg,
  answered: results.filter((r) => r.answer).length,
  durationMs: {
    total: durations.reduce((sum, duration) => sum + duration, 0),
    median: durations[Math.floor(durations.length / 2)] || 0,
    p95: durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] || 0,
  },
  indicators: counts,
  categories,
  results,
};

const output = arg('--output');
if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
