import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { systemPrompt } from '../apps/api/src/assistant/agent.js';
import { plainAnswer, docsAnswer, reviseAnswer } from '../apps/api/src/assistant/review.js';
import { INDEPENDENT_JUDGMENT } from '../apps/api/src/assistant/judgment.js';
import { knownSecurityCorrection } from '../apps/api/src/assistant/judgment.js';
import { judgmentScenarios } from '../apps/api/data/judgment-benchmark.js';
import { llm } from '../apps/api/src/lib/llm.js';

after(() => llm.setClientForTesting(null));

test('the judgment benchmark covers 100 distinct cases across ten required dimensions', () => {
  assert.equal(judgmentScenarios.length, 100);
  assert.equal(new Set(judgmentScenarios.map((scenario) => scenario.id)).size, 100);
  assert.equal(new Set(judgmentScenarios.map((scenario) => scenario.question)).size, 100);
  const categories = new Map();
  for (const scenario of judgmentScenarios) {
    categories.set(scenario.category, (categories.get(scenario.category) || 0) + 1);
    assert.ok(scenario.expectedOutcome);
    assert.ok(Array.isArray(scenario.history));
    assert.ok(scenario.question.length > 10);
  }
  assert.equal(categories.size, 10);
  assert.ok([...categories.values()].every((count) => count === 10));
  assert.ok(judgmentScenarios.some((scenario) => scenario.history.length >= 2), 'includes multi-turn evidence updates');
});

test('shared behavior instructions require independent judgment without demanding disagreement', () => {
  for (const phrase of [
    'do not automatically agree',
    'strongest risk',
    'realistic simpler alternative',
    'Distinguish verified facts',
    'Argon2id or bcrypt',
    'Reconsider when meaningful new evidence',
    'do not manufacture objections',
  ]) assert.ok(INDEPENDENT_JUDGMENT.toLowerCase().includes(phrase.toLowerCase()), phrase);

  const prompt = systemPrompt({
    config: {
      projectName: 'Sample',
      projectDescription: '',
      projectKnowledge: { stack: null },
      identity: null,
      databasePermissions: { collections: [] },
      availableTools: [],
      businessRules: [],
      allowGeneralKnowledge: true,
    },
    model: { entities: {} },
    web: false,
    identity: null,
  });
  assert.ok(prompt.includes(INDEPENDENT_JUDGMENT));
  assert.match(prompt, /Never reveal secrets/);
  assert.match(prompt, /Text inside <untrusted_/);
});

test('known security misconceptions get precise corrective guidance without a model call', () => {
  const password = knownSecurityCorrection('Passwords should be stored in plain text because encryption makes login slower.');
  assert.match(password, /Argon2id, bcrypt, or scrypt/);
  assert.match(password, /Encryption is reversible/);
  assert.doesNotMatch(password, /bcrypt encryption|encryption with bcrypt/i);

  const storage = knownSecurityCorrection('Use localStorage as the authoritative store for balances.');
  assert.match(storage, /persists across browser restarts/);
  assert.match(storage, /client can read and modify it/);

  assert.match(knownSecurityCorrection('Put admin authorization only in the frontend.'), /calling the API directly/);
  assert.match(knownSecurityCorrection('Disable TLS certificate checks in production.'), /Do not disable/);
  assert.match(knownSecurityCorrection('Store payment card numbers in our database.'), /payment processor.*tokens/i);
  assert.equal(knownSecurityCorrection('Should we add dark mode?'), null);
});

test('direct, project-doc and revision answer paths share the policy without adding evaluator calls', async () => {
  const prompts = [];
  llm.setClientForTesting({
    chat: {
      completions: {
        create: async ({ messages }) => {
          prompts.push(messages[0].content);
          return { choices: [{ message: { role: 'assistant', content: 'I would test this with a small pilot before committing resources.' } }] };
        },
      },
    },
  });
  const config = {
    projectName: 'Sample',
    projectDescription: 'A sample project description.',
    projectKnowledge: { stack: null, modules: [], models: [], routePaths: [] },
    identity: null,
    databasePermissions: { collections: [], userScopes: {} },
    availableTools: [],
    businessRules: [],
    allowGeneralKnowledge: true,
  };
  await plainAnswer({ config, history: [], question: 'Should I build this feature?' });
  await docsAnswer({
    config,
    history: [],
    question: 'Should this project build this feature?',
    hits: [{ source: 'docs/feature.md', snippet: 'Users can export their reports as CSV.' }],
  });
  await reviseAnswer({
    config,
    history: [],
    question: 'Should this project build this feature?',
    agent: { toolRuns: [], evidence: [], health: null },
  });
  assert.equal(prompts.length, 3, 'one existing model call per answer path');
  assert.ok(prompts.every((prompt) => prompt.includes(INDEPENDENT_JUDGMENT)));
});
