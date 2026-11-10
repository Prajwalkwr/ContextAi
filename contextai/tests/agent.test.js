// Live data tools, health checks and the conversational agent. Data questions without a model go
// through the validated tools; with a model (stubbed here) the agent reads the whole conversation,
// chooses the tools itself and every tool call is validated before it touches data.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { startApi } from './helpers.js';
import { runAgent } from '../apps/api/src/assistant/agent.js';
import { buildProjectConfig } from '../apps/api/src/assistant/projectConfig.js';

let api;
let token;
let market;
let unreviewed;
let empty;
let llm;
let site;

const businesses = [
  { _id: 'b1', name: 'Himalayan Momo House', category: 'Restaurant', approvalStatus: 'approved', rating: 4.8, reviewCount: 5 },
  { _id: 'b2', name: 'Kathmandu Tailors', category: 'Clothing', approvalStatus: 'approved', rating: 4.5, reviewCount: 2 },
  { _id: 'b3', name: 'Pokhara Electronics', category: 'Electronics', approvalStatus: 'pending', rating: 5, reviewCount: 9 },
  { _id: 'b4', name: 'Lalitpur Bakery', category: 'Restaurant', approvalStatus: 'approved', rating: 4.2, reviewCount: 5 },
  { _id: 'b5', name: 'Bhaktapur Pottery', category: 'Crafts', approvalStatus: 'approved', rating: 0, reviewCount: 0 },
];
const stars = { b1: [5, 5, 5, 5, 4], b2: [5, 4], b4: [4, 4, 4, 4, 5] };
const reviews = Object.entries(stars).flatMap(([businessId, list]) => list.map((rating, i) => ({
  _id: `${businessId}-r${i}`, businessId, targetType: 'business', rating, comment: rating === 5 ? 'Excellent, would come again' : 'Good but slow', customerId: `c${i}`,
})));
const products = [
  { _id: 'p1', name: 'Momo Platter', price: 350, stock: 10, isAvailable: true },
  { _id: 'p2', name: 'Silk Scarf', price: 1200, stock: 0, isAvailable: true },
  { _id: 'p3', name: 'Clay Pot', price: 800, stock: 4, isAvailable: false },
  { _id: 'p4', name: 'Bread Loaf', price: 90, stock: 25, isAvailable: true },
];

const ask = async (proj, question, extra = {}) => (await api.call('POST', `/api/v1/projects/${proj.id}/ask`, { token, body: { question, ...extra } })).body;

// One conversation: each answer's conversationId is sent with the next question.
async function conversation(proj, questions) {
  const out = [];
  let conversationId;
  for (const q of questions) {
    const r = await ask(proj, q, conversationId ? { conversationId } : {});
    conversationId = r.conversationId;
    out.push(r);
  }
  return out;
}

before(async () => {
  api = await startApi();
  ({ llm } = await import('../apps/api/src/lib/llm.js'));
  token = await api.user('tools@example.com');
  market = await api.project(token, 'UdyogConnect');
  await api.call('POST', `/api/v1/projects/${market.id}/integrations`, { token, body: { type: 'dataset', name: 'Live API', collections: { businesses, reviews, products } } });
  unreviewed = await api.project(token, 'Fresh Market');
  await api.call('POST', `/api/v1/projects/${unreviewed.id}/integrations`, { token, body: { type: 'dataset', name: 'Live API', collections: { businesses: businesses.map((b) => ({ ...b, rating: 0, reviewCount: 0 })) } } });
  empty = await api.project(token, 'Unconnected');

  // A single-page app that answers every path with its HTML shell, plus real JSON health routes.
  site = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ status: 'ok', database: 'disconnected' })); }
    if (req.url === '/api/health/status') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ server: 'running', database: { type: 'JSON File Storage (Development)', status: 'connected' } })); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><title>UdyogConnect</title></head><body><div id="root"></div></body></html>');
  }).listen(0);
  await new Promise((r) => site.once('listening', r));
});
after(async () => { llm?.setClientForTesting(null); site?.close(); await api.close(); });

describe('live data tools (no language model)', () => {
  test('highest rating excludes unapproved businesses and names the review count', async () => {
    const r = await ask(market, 'Which business has the highest rating?');
    assert.match(r.answer, /Himalayan Momo House/);
    assert.match(r.answer, /4\.8/);
    assert.match(r.answer, /5 reviews/);
    assert.doesNotMatch(r.answer, /Pokhara/, 'pending businesses are not visible to customers');
    assert.ok(r.evidence.some((e) => e.kind === 'live_data'));
  });

  test('follow-ups resolve "it", "second-highest" and "why" from the conversation', async () => {
    const [top, count, second, why] = await conversation(market, [
      'Which business has the highest rating?',
      'How many reviews does it have?',
      'Show me the second-highest-rated business.',
      'Why does it have that rating?',
    ]);
    assert.match(top.answer, /Himalayan Momo House/);
    assert.match(count.answer, /Himalayan Momo House/);
    assert.match(count.answer, /5 reviews/);
    assert.match(second.answer, /Kathmandu Tailors/);
    assert.match(why.answer, /Kathmandu Tailors/);
    assert.match(why.answer, /5★ and 4★/);
  });

  test('top five, average and most reviewed use only eligible, reviewed businesses', async () => {
    const top5 = await ask(market, 'Show the top five highest-rated businesses.');
    assert.match(top5.answer, /1\. Himalayan Momo House/);
    assert.match(top5.answer, /2\. Kathmandu Tailors/);
    assert.match(top5.answer, /3\. Lalitpur Bakery/);
    assert.match(top5.answer, /no reviews yet/);
    assert.doesNotMatch(top5.answer, /Pokhara|Bhaktapur Pottery:/);

    const avg = await ask(market, 'What is the average rating across all eligible businesses?');
    assert.match(avg.answer, /4\.5 out of 5/, '(4.8 + 4.5 + 4.2) / 3');

    const most = await ask(market, 'Which business has the most reviews?');
    assert.match(most.answer, /Himalayan Momo House/);
    assert.match(most.answer, /5 reviews/);
  });

  test('counts report the approval breakdown, reviews and stock-aware availability', async () => {
    const biz = await ask(market, 'How many businesses are registered?');
    assert.match(biz.answer, /5 businesses registered in total/);
    assert.match(biz.answer, /4 are approved/);
    assert.match(biz.answer, /1 pending/);

    const rev = await ask(market, 'How many reviews have been submitted?');
    assert.match(rev.answer, /12 reviews have been submitted/);

    const avail = await ask(market, 'How many products are currently available?');
    assert.match(avail.answer, /2 of the 4 products/);
  });

  test('an empty ratings collection is reported as such, not as missing access', async () => {
    const r = await ask(unreviewed, 'Which business has the highest rating?');
    assert.match(r.answer, /None of the 4 businesses on Fresh Market has been reviewed yet/);
    assert.doesNotMatch(r.answer, /no access|not connected/i);
  });

  test('"what happens when…" questions describe the implemented failure handling', async () => {
    const empty = await ask(market, 'What happens when the ratings collection is empty?');
    assert.equal(empty.route.method, 'behaviour');
    assert.match(empty.answer, /has been reviewed yet/);
    const html = await ask(market, 'What happens when the crawler returns HTML instead of structured data?');
    assert.match(html.answer, /HTML is never treated as data/);
    const priv = await ask(market, 'What happens when a user asks for inaccessible private data?');
    assert.match(priv.answer, /only that user's own records/);
    const dbDown = await ask(market, 'What happens when the database is unavailable?');
    assert.match(dbDown.answer, /isn't reachable right now/);
  });

  test('a data source that returns an HTML page is an error, not an empty collection', async () => {
    const shell = await api.project(token, 'Shell Site');
    const url = `http://127.0.0.1:${site.address().port}/api/businesses`;
    await api.call('POST', `/api/v1/projects/${shell.id}/integrations`, { token, body: { type: 'http', name: 'Wrong URL', config: { mode: 'rest', sources: [{ name: 'businesses', url }] } } });
    const { body } = await api.call('GET', `/api/v1/projects/${shell.id}`, { token });
    const it = body.integrations[0];
    assert.notEqual(it.status, 'connected');
    assert.match(JSON.stringify(it.health || it), /HTML page instead of JSON/);
    const r = await ask(shell, 'How many businesses are registered?');
    assert.doesNotMatch(r.answer, /no businesses/i);
  });

  test('without a data source the answer says so plainly', async () => {
    const r = await ask(empty, 'Which business has the highest rating?');
    assert.match(r.answer, /no business data source is connected/);
    assert.doesNotMatch(r.answer, /\d\.\d/, 'no invented rating');
  });
});

describe('health checks', () => {
  test('HTML is never a health report; database fallback is reported as degraded', async () => {
    const url = `http://127.0.0.1:${site.address().port}`;
    await api.call('PATCH', `/api/v1/projects/${market.id}`, { token, body: { websiteUrl: url, statusUrl: `${url}/api/health/status` } });
    const { body } = await api.call('GET', `/api/v1/projects/${market.id}/health?fresh=true`, { token });
    assert.equal(body.health.website.state, 'up');
    assert.equal(body.health.backend.state, 'up');
    assert.equal(body.health.database.state, 'degraded');
    assert.equal(body.health.overall, 'degraded');
    assert.ok(body.health.backend.rejected.some((x) => /HTML/.test(x.reason)), 'the SPA shell served at /healthz and /status is rejected');

    for (const q of ['Is the website online?', 'Is the backend healthy?', 'Is the database connected?']) {
      const r = await ask(market, q);
      assert.equal(r.answerMode, 'health_check', q);
      assert.doesNotMatch(r.answer, /<\/?[a-z]+[\s>]|doctype/i, `${q} must not echo HTML`);
    }
    const dbAnswer = await ask(market, 'Is the database connected?');
    assert.match(dbAnswer.answer, /not connected/);
    assert.match(dbAnswer.answer, /JSON File Storage/);
  });
});

describe('conversational agent (stubbed model)', () => {
  let seen;
  const reply = (message) => ({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const call = (name, args, id = 'call_1') => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

  before(() => {
    seen = [];
    // These tests exercise the model's own reasoning, so recognised questions are not short-circuited.
    process.env.ASSISTANT_VERIFIED_FAST_PATH = 'false';
    llm.setClientForTesting({
      chat: {
        completions: {
          create: async (params) => {
            seen.push({ ...params, messages: [...params.messages] });
            const last = params.messages.at(-1);
            if (last.role === 'tool') {
              const data = JSON.parse(last.content);
              return reply({ role: 'assistant', content: data.answer || data.message || `Tool error: ${data.error}` });
            }
            const q = last.content;
            if (/highest rating/.test(q)) return reply(call('rank_by_rating', { entity: 'business', order: 'desc', limit: 1 }));
            if (/reviews does it have/.test(q)) {
              // A real model resolves "it" from the earlier turns it was given.
              const earlier = params.messages.filter((m) => m.role === 'assistant' && /\*\*(.+?)\*\*/.test(m.content || '')).at(-1);
              const name = earlier.content.match(/\*\*(.+?)\*\*/)[1];
              return reply(call('lookup_record', { entity: 'business', name, focus: 'reviews' }));
            }
            if (/secret collection/.test(q)) return reply(call('rank_by_rating', { entity: 'passwords' }));
            return reply({ role: 'assistant', content: 'Mars has two moons, Phobos and Deimos.' });
          },
        },
      },
    });
  });
  after(() => { llm.setClientForTesting(null); delete process.env.ASSISTANT_VERIFIED_FAST_PATH; });

  test('the model receives the whole conversation and resolves references through tools', async () => {
    const questions = [
      'Which business has the highest rating?',
      ...Array.from({ length: 7 }, () => 'How many moons does Mars have?'),
      'How many reviews does it have?',
    ];
    const results = await conversation(market, questions);
    const first = results[0];
    const second = results.at(-1);
    assert.match(first.answerMode, /^agent:/);
    assert.match(first.answer, /Himalayan Momo House/);
    assert.deepEqual(first.route.intents, ['AGENT']);

    const followUp = seen.filter((p) => p.messages.at(-1).role === 'user').at(-1);
    assert.ok(followUp.messages.some((m) => m.role === 'user' && /highest rating/.test(m.content)), 'the first topic remains in context after more than six turns');
    assert.ok(followUp.messages.some((m) => m.role === 'assistant' && /Himalayan Momo House/.test(m.content)), 'the earlier answer remains available for resolving references');
    assert.equal(followUp.messages.filter((m) => m.role === 'user').length, questions.length);
    assert.match(followUp.messages.at(-1).content, /reviews does it have/);
    assert.ok(followUp.tools.some((t) => t.function.name === 'lookup_record'), 'tools are offered for the connected data');
    assert.match(followUp.messages[0].content, /not just matching keywords in the latest message/);

    assert.match(second.answer, /Himalayan Momo House\W+has 5 reviews/);
    assert.ok(second.toolCalls.some((c) => c.startsWith('lookup_record')));
  });

  test('agent prompt requires contextual, complete answers without filler', async () => {
    const r = await ask(market, 'How many moons does Mars have?');
    assert.match(r.answer, /two moons/);
    const answerCall = seen.findLast((p) => p.messages.at(-1).role === 'user');
    const prompt = answerCall.messages[0].content;
    assert.match(prompt, /whole conversation to identify the user's actual question/i);
    assert.match(prompt, /detail proportional to its complexity/i);
    assert.match(prompt, /Output only the answer/i);
    assert.match(prompt, /no preamble, restatement of the question, process narration/i);
  });

  test('agent reuses the data catalog prepared by the verified fast path', async () => {
    const config = buildProjectConfig(market);
    await runAgent({
      project: market,
      config,
      question: 'How many moons does Mars have?',
      history: [],
      actor: 'test',
      identity: null,
      model: { entities: { business: { kind: 'business', count: 321 } } },
      trail: { step() {} },
    });
    const call = seen.at(-1);
    assert.match(call.messages[0].content, /business: 321 live records/);
  });

  test('invalid tool arguments are rejected before any data is read', async () => {
    const r = await ask(market, 'Rank the secret collection');
    const toolMsg = seen.at(-1).messages.at(-1);
    assert.equal(toolMsg.role, 'tool');
    assert.match(toolMsg.content, /"status":"error"/);
    assert.doesNotMatch(r.answer, /password/i);
  });

  test('general questions are answered by the model without project data', async () => {
    const r = await ask(market, 'How many moons does Mars have?');
    assert.match(r.answer, /two moons/);
    assert.deepEqual(r.route.sources, ['model_knowledge']);
    assert.equal(r.evidence.length, 0);
  });

  test('a draft with figures no tool produced is rejected and answered from live data', async () => {
    llm.setClientForTesting({ chat: { completions: { create: async ({ messages }) => reply(messages.some((m) => m.role === 'tool')
      ? { role: 'assistant', content: 'There are 9 businesses registered.' }
      : call('count_records', { entity: 'business' })) } } });
    const r = await ask(market, 'How many businesses are registered?');
    assert.doesNotMatch(r.answer, /\b9 businesses/);
    assert.match(r.answer, /5 businesses registered in total/);
    assert.ok(r.plan.some((s) => s.action === 'review' && /figures no source supports \(9\)/.test(s.detail)));
  });

  test('a malformed reply to a general question gets one plain retry', async () => {
    let calls = 0;
    llm.setClientForTesting({ chat: { completions: { create: async ({ tools }) => { calls++; return reply({ role: 'assistant', content: tools?.length ? '{}' : 'Mars has two moons, Phobos and Deimos.' }); } } } });
    const r = await ask(market, 'How many moons does Mars have?');
    assert.equal(r.answer, 'Mars has two moons, Phobos and Deimos.');
    assert.equal(r.route.method, 'agent_retry');
    assert.ok(calls >= 2);
  });

  test('when the model fails, the rule-based pipeline still answers from live data', async () => {
    llm.setClientForTesting({ chat: { completions: { create: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } } } });
    const r = await ask(market, 'Which business has the highest rating?');
    assert.match(r.answer, /Himalayan Momo House/);
    assert.ok(r.limitations.some((l) => /AI model was unavailable/.test(l)) || r.answerMode === 'tool');
  });
});

describe('verified fast path (model enabled)', () => {
  let modelCalls = 0;
  before(() => llm.setClientForTesting({ chat: { completions: { create: async () => { modelCalls++; return { choices: [{ message: { role: 'assistant', content: 'The top business has 9 reviews.' } }], usage: {} }; } } } }));
  after(() => llm.setClientForTesting(null));

  test('recognised record questions and follow-ups are answered by validated tools, not the model', async () => {
    const [top, count] = await conversation(market, ['Which business has the highest rating?', 'How many reviews does it have?']);
    assert.equal(top.answerMode, 'tool');
    assert.match(top.answer, /Himalayan Momo House/);
    assert.equal(count.answerMode, 'tool');
    assert.match(count.answer, /Himalayan Momo House\W+has 5 reviews/);
    assert.doesNotMatch(count.answer, /9 reviews/);
    assert.ok(top.plan.some((s) => s.action === 'verified_route'));
  });

  test('"latest" questions without a search provider are not answered from model memory', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'none';
    try {
      const before = modelCalls;
      const r = await ask(market, 'What are the latest AI developments?');
      assert.match(r.answer, /can't check current information/);
      assert.equal(modelCalls, before, 'the model was not asked');
    } finally {
      delete process.env.WEB_SEARCH_PROVIDER;
    }
  });

  test('the model-backed reviewer rejects unchecked "no data" claims about records', async () => {
    const { reviewAgentAnswer } = await import('../apps/api/src/assistant/review.js');
    const config = { projectName: 'UdyogConnect', projectKnowledge: {}, databasePermissions: { collections: [] }, availableTools: [], businessRules: [] };
    const base = { toolRuns: [], evidence: [], health: null };
    assert.equal(reviewAgentAnswer({ agent: { ...base, answer: "I couldn't find any information on their ratings." }, config, history: [], question: 'Which business has the most reviews?', projectData: true }).ok, false);
    assert.equal(reviewAgentAnswer({ agent: { ...base, answer: '{}' }, config, history: [], question: 'What is React?', projectData: false }).retryPlain, true);
    assert.equal(reviewAgentAnswer({ agent: { ...base, answer: 'There is no function call that can provide the number of moons.' }, config, history: [], question: 'How many moons does Mars have?', projectData: false }).retryPlain, true);
    assert.equal(reviewAgentAnswer({ agent: { ...base, answer: 'React is a JavaScript library for building user interfaces.' }, config, history: [], question: 'What is React?', projectData: false }).ok, true);
    const grounded = { ...base, toolRuns: [{ answer: 'There are 9 approved businesses.', data: { total: 9 } }], answer: 'UdyogConnect has 9 approved businesses.' };
    assert.equal(reviewAgentAnswer({ agent: grounded, config, history: [], question: 'How many businesses?', projectData: true }).ok, true);
  });
});
