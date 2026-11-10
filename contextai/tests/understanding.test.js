// How the assistant classifies a question before any model sees it: small talk, general
// knowledge that shouldn't touch project tools, and current information.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { asksCurrent, smallTalkKind } from '../apps/api/src/assistant/router.js';
import { generalOnly } from '../apps/api/src/assistant/searchPolicy.js';
import { calculate } from '../apps/api/src/assistant/calculate.js';
import { reviewAgentAnswer } from '../apps/api/src/assistant/review.js';

const signals = (question, over = {}) => ({
  smallTalk: false, personal: false, command: false, definitionHit: false, listsRecords: false,
  implementation: false, projectMention: false, structureHit: false, followUp: false, generalSubject: false,
  dataMatches: [], current: asksCurrent(question), corpus: { coverage: 0.2, empty: false }, ...over,
});
const general = (question, over) => generalOnly({ question, signals: signals(question, over) });

describe('small talk', () => {
  test('greetings, thanks and goodbyes', () => {
    assert.equal(smallTalkKind('hi there'), 'greeting');
    assert.equal(smallTalkKind('good morning!'), 'greeting');
    assert.equal(smallTalkKind('thanks, that helps'), 'thanks');
    assert.equal(smallTalkKind('ok got it, thanks a lot'), 'thanks');
    assert.equal(smallTalkKind('bye'), 'bye');
  });

  test('questions about what the assistant can do', () => {
    assert.equal(smallTalkKind('What can you help me with?'), 'capabilities');
    assert.equal(smallTalkKind('who are you?'), 'capabilities');
  });

  test('real questions are not small talk', () => {
    assert.equal(smallTalkKind('thanks, how do I place an order?'), null);
    assert.equal(smallTalkKind('Is the site down?'), null);
  });
});

describe('general knowledge', () => {
  test('questions about the world go straight to the model', () => {
    assert.equal(general('What is the capital of Australia?'), true);
    assert.equal(general('Who painted the Mona Lisa?'), true);
  });

  test('tasks on the user\'s text count even when the project shares their words', () => {
    assert.equal(general('Translate "thank you" into Nepali', { structureHit: true, corpus: { coverage: 1, empty: false } }), true);
    assert.equal(general('Convert 5 km to miles', { structureHit: true }), true);
  });

  test('words that only occur inside the project\'s source code do not make it a project question', () => {
    assert.equal(general('Why is the sky blue?', { corpus: { coverage: 1, prose: 0, empty: false } }), true);
    assert.equal(general('How does the rider dashboard work?', { corpus: { coverage: 1, prose: 1, empty: false } }), false);
    assert.equal(general('Is there a dark mode?', { corpus: { coverage: 1, prose: 0, empty: false } }), false);
  });

  test('anything about the project or its records does not', () => {
    assert.equal(general('Summarize UdyogConnect', { projectMention: true }), false);
    assert.equal(general('Do you deliver outside Kathmandu?', { corpus: { coverage: 1, empty: false } }), false);
    assert.equal(general('What is the cheapest product?'), false);
    assert.equal(general('What is the capital of Australia?', { corpus: { coverage: 0, empty: true } }), false);
  });
});

describe('calculations', () => {
  test('percentages, arithmetic and unit conversions are exact', () => {
    assert.equal(calculate('What is 15% of 240?'), '15% of 240 is 36.');
    assert.equal(calculate('calculate 23 * 47'), '23 * 47 = 1,081');
    assert.equal(calculate('What is (3 + 4)^2 - 1?'), '(3 + 4)^2 - 1 = 48');
    assert.equal(calculate('Convert 10 km to miles'), '10 kilometres is 6.2137 miles.');
    assert.equal(calculate('How many feet are in 2 meters?'), '2 metres is 6.5617 feet.');
    assert.equal(calculate('convert 100°F to celsius'), '100 °F is 37.7778 °C.');
  });

  test('anything else is left to the model', () => {
    assert.equal(calculate('Convert 100 US dollars to Nepali rupees'), null);
    assert.equal(calculate('What is the cheapest product?'), null);
    assert.equal(calculate('How many orders were placed in 2025?'), null);
    assert.equal(calculate('Convert 10 km to kg'), null);
  });
});

describe('reviewing yes/no answers', () => {
  const review = (answer, snippet, question, kind = 'indexed_doc') => reviewAgentAnswer({
    agent: { answer, toolRuns: [], health: null, evidence: [{ snippet, kind }] },
    config: { projectName: 'Shop', allowGeneralKnowledge: true, projectKnowledge: {}, databasePermissions: { collections: [] }, availableTools: [], businessRules: [] },
    history: [], question, projectData: false,
  }).ok;

  test('a verdict needs a source that mentions everything the question asks about', () => {
    assert.equal(review('Yes, there is a mobile app.', 'Enter a 10-digit mobile number at checkout.', 'Is there a mobile app?'), false);
    assert.equal(review('Yes, there is a mobile app.', '<div className="mobile-menu">{/* app shell */}</div>', 'Is there a mobile app?', 'indexed_code'), false);
    assert.equal(review('Yes, Shop delivers outside Kathmandu.', 'Businesses choose delivery and a delivery radius.', 'Do you deliver outside Kathmandu?'), false);
    assert.equal(review('Yes, you can cancel an order while it is placed.', 'You can cancel your own order while it is placed or accepted.', 'Can I cancel my order on this site?'), true);
    assert.equal(review('The platform delivers outside Kathmandu.', 'Businesses choose delivery and a delivery radius.', 'Do you deliver outside Kathmandu?'), false);
    assert.equal(review('Delivery outside Kathmandu is not mentioned; each business sets its own delivery radius.', 'Businesses choose delivery and a delivery radius.', 'Do you deliver outside Kathmandu?'), true);
  });
});

describe('current information', () => {
  test('currency conversions depend on live exchange rates', () => {
    assert.equal(asksCurrent('Convert 100 US dollars to Nepali rupees'), true);
    assert.equal(asksCurrent('How much is 50 euros in NPR?'), true);
    assert.equal(general('Convert 100 US dollars to Nepali rupees'), false);
  });

  test('unit conversions and prices in one currency are not current', () => {
    assert.equal(asksCurrent('Convert 10 km to miles'), false);
    assert.equal(asksCurrent('Show products under 500 rupees'), false);
  });
});
