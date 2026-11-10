// Google Search grounding (Gemini Interactions API). A stub implementing `interactions.create`
// stands in for @google/genai so routing, citations, quota handling and the hand-off from the
// project tools can be checked exactly. Live requests are exercised by
// apps/api/scripts/test-google-search.js with a real GEMINI_API_KEY.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startApi } from './helpers.js';
import { parseInteraction } from '../apps/api/src/lib/googleSearch.js';

let api;
let token;
let p;
let llm;
let googleSearch;
let site;

const files = [
  { path: 'README.md', content: '# UdyogConnect\nUdyogConnect is a marketplace that connects customers with local businesses in Nepal. Customers discover nearby businesses, order products and book services.' },
  { path: 'docs/payments.md', content: '## Payments\nUdyogConnect supports cash on delivery and eSewa wallet payments for orders. Card payments are not available.' },
];
const businesses = [
  { _id: 'b1', name: 'Himalayan Momo House', category: 'Restaurant', approvalStatus: 'approved', rating: 4.8, reviewCount: 5 },
  { _id: 'b2', name: 'Kathmandu Tailors', category: 'Clothing', approvalStatus: 'approved', rating: 4.5, reviewCount: 2 },
  { _id: 'b3', name: 'Lalitpur Bakery', category: 'Restaurant', approvalStatus: 'approved', rating: 4.2, reviewCount: 5 },
];

const SUGGESTIONS = '<style>.chip{}</style><div class="container"><a class="chip" href="https://www.google.com/search?q=latest+ai+news">latest ai news</a></div>';

// An interaction as the Interactions API returns it when the model ran Google Search.
function groundedInteraction(text, cites, queries = ['latest news']) {
  return {
    id: 'int_1', status: 'completed',
    steps: [
      { type: 'google_search_call', id: 's1', arguments: { queries } },
      { type: 'google_search_result', call_id: 's1', result: [{ search_suggestions: SUGGESTIONS }] },
      { type: 'model_output', content: [{ type: 'text', text, annotations: cites.map(([phrase, url, title]) => ({ type: 'url_citation', url, title, start_index: text.indexOf(phrase), end_index: text.indexOf(phrase) + phrase.length })) }] },
    ],
    usage: { total_input_tokens: 600, total_output_tokens: 120, total_thought_tokens: 40, grounding_tool_count: [{ type: 'google_search', count: queries.length }] },
  };
}
const plainInteraction = (text) => ({ id: 'int_2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: { total_input_tokens: 200, total_output_tokens: 30 } });

function gemini(reply) {
  const calls = [];
  return { calls, interactions: { create: async (params, options) => { calls.push({ params, options }); return reply(params, calls.length); } } };
}
const apiError = (status, message, extra = {}) => Object.assign(new Error(message), { status, body: JSON.stringify({ error: { code: status, message, status: 'X', ...extra } }) });

const AI_NEWS = 'In November 2026, several labs released new reasoning models and regulators published AI safety guidance.';
const aiNews = () => groundedInteraction(AI_NEWS, [
  ['released new reasoning models', 'https://news.example.com/ai-models', 'Example News'],
  ['published AI safety guidance', 'https://gov.example.org/ai-guidance', 'gov.example.org'],
], ['latest AI developments November 2026']);

const ask = async (question, extra = {}) => (await api.call('POST', `/api/v1/projects/${p.id}/ask`, { token, body: { question, ...extra } })).body;

before(async () => {
  api = await startApi();
  ({ llm } = await import('../apps/api/src/lib/llm.js'));
  ({ googleSearch } = await import('../apps/api/src/lib/googleSearch.js'));
  site = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', database: 'connected' })); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>UdyogConnect</title>');
  }).listen(0);
  await new Promise((r) => site.once('listening', r));
  token = await api.user('search@example.com');
  p = await api.project(token, 'UdyogConnect');
  await api.call('PATCH', `/api/v1/projects/${p.id}`, { token, body: { description: 'Marketplace connecting customers with local businesses.', websiteUrl: `http://127.0.0.1:${site.address().port}` } });
  const r = await api.call('POST', `/api/v1/projects/${p.id}/knowledge/index`, { token, body: { files } });
  assert.equal((await api.waitForJob(token, p.id, r.body.job.id)).status, 'completed');
  await api.call('POST', `/api/v1/projects/${p.id}/integrations`, { token, body: { type: 'dataset', name: 'Live API', collections: { businesses } } });
});
after(() => {
  googleSearch?.setClientForTesting(null);
  llm?.setClientForTesting(null);
  site?.close();
  return api.close();
});
beforeEach(() => {
  googleSearch.resetForTesting();
  delete process.env.GEMINI_SEARCH_DAILY_LIMIT;
});

describe('parsing Gemini interactions', () => {
  test('citation markers come from Google annotations; only returned http(s) URLs are kept', () => {
    const r = parseInteraction(groundedInteraction('React 19.2 is the latest stable release. It added Activity.', [
      ['latest stable release', 'https://react.dev/blog/react-19-2', 'React Blog'],
      ['added Activity', 'https://react.dev/blog/react-19-2', 'React Blog'],
      ['React 19.2', 'javascript:alert(1)', 'bad'],
    ], ['latest React version']));
    assert.equal(r.answer, 'React 19.2 is the latest stable release [1]. It added Activity [1].');
    assert.deepEqual(r.citations, [{ url: 'https://react.dev/blog/react-19-2', title: 'React Blog' }]);
    assert.deepEqual(r.queries, ['latest React version']);
    assert.equal(r.searchSuggestions, SUGGESTIONS);
    assert.equal(r.searches, 1);
    assert.deepEqual(r.usage, { input_tokens: 600, output_tokens: 160 });
  });

  test('an answer without a search has no citations or suggestions', () => {
    const r = parseInteraction(plainInteraction('Mars has two moons.'));
    assert.equal(r.answer, 'Mars has two moons.');
    assert.equal(r.citations.length, 0);
    assert.equal(r.searchSuggestions, null);
    assert.equal(r.searches, 0);
  });
});

describe('the seven routing questions (Gemini only, no main language model)', () => {
  let stub;
  beforeEach(() => {
    stub = gemini((params) => {
      if (/Mars/.test(params.input)) return plainInteraction('Mars has two natural moons, Phobos and Deimos.');
      if (/React/.test(params.input)) return groundedInteraction('React 19.2 is the latest stable version (released October 2025); it runs on Node.js 20 or newer.', [['React 19.2 is the latest stable version', 'https://react.dev/versions', 'react.dev']], ['latest React version']);
      if (/this week/.test(params.input)) return groundedInteraction('This week, chipmakers reported record earnings and a major cloud outage was resolved.', [['record earnings', 'https://tech.example.com/earnings', 'Tech Example'], ['cloud outage', 'https://status.example.net/incident', 'status.example.net']], ['technology industry news this week']);
      return aiNews();
    });
    googleSearch.setClientForTesting(stub);
  });

  test('1. "How many moons does Mars have?" is general knowledge; Gemini may skip the search', async () => {
    const r = await ask('How many moons does Mars have?');
    assert.equal(stub.calls.length, 1);
    const { params } = stub.calls[0];
    assert.equal(params.model, 'gemini-3.5-flash-lite', 'general questions use the fast model');
    assert.deepEqual(params.tools, [{ type: 'google_search' }]);
    assert.equal(params.store, false);
    assert.match(params.system_instruction, /only if it would materially improve accuracy/);
    assert.equal(r.status, 'success');
    assert.equal(r.answer, 'Mars has two natural moons, Phobos and Deimos.');
    assert.deepEqual(r.route.sources, ['model_knowledge']);
    assert.equal(r.webSearch.searched, false);
    assert.equal(r.answerMode, 'gemini:gemini-3.5-flash-lite');
    assert.equal(r.citations.length, 0);
  });

  test('stable general knowledge uses the configured main model before optional Google search', async () => {
    const mainCalls = [];
    const main = { chat: { completions: { create: async (params) => {
      mainCalls.push(params);
      return { choices: [{ message: { content: 'Mars has two natural moons, Phobos and Deimos.' } }] };
    } } } };
    const noSearch = gemini(() => { throw new Error('Google Search should not be called for stable general knowledge when the main model works'); });
    llm.setClientForTesting(main);
    googleSearch.setClientForTesting(noSearch);
    try {
      const r = await ask('How many moons does Mars have?');
      assert.equal(r.status, 'success');
      assert.equal(r.answer, 'Mars has two natural moons, Phobos and Deimos.');
      assert.equal(mainCalls.length, 1);
      assert.equal(noSearch.calls.length, 0);
    } finally {
      llm.setClientForTesting(null);
    }
  });

  test('2. "latest AI news" runs Google Search and returns grounded citations', async () => {
    const r = await ask('What is the latest AI news?');
    assert.equal(stub.calls.length, 1);
    const { params, options } = stub.calls[0];
    assert.equal(params.model, 'gemini-3.8-flash', 'research questions use the research model');
    assert.match(params.system_instruction, /use Google Search before answering/);
    assert.match(params.system_instruction, /authoritative sources/);
    assert.match(params.system_instruction, /Do not write URLs/);
    assert.ok(!/UdyogConnect is a marketplace/.test(params.input), 'no project content is sent for a pure web question');
    assert.equal(options.timeout, 30000);
    assert.deepEqual(r.route.sources, ['web_search']);
    assert.equal(r.route.method, 'search_policy');
    assert.equal(r.status, 'success');
    assert.equal(r.answer, 'In November 2026, several labs released new reasoning models [1] and regulators published AI safety guidance [2].');
    assert.deepEqual(r.citations, [
      { index: 1, url: 'https://news.example.com/ai-models', title: 'Example News' },
      { index: 2, url: 'https://gov.example.org/ai-guidance', title: 'gov.example.org' },
    ]);
    assert.equal(r.searchSuggestions, SUGGESTIONS);
    assert.deepEqual(r.webSearch.queries, ['latest AI developments November 2026']);
    assert.equal(r.webSearch.grounded, true);
    assert.equal(r.confidence, 'high');
    assert.ok(r.sources.every((s) => s.type === 'web_page'));
  });

  test('3. "latest React version" is answered verbatim from the grounded result', async () => {
    const r = await ask('What is the latest React version?');
    assert.deepEqual(r.route.sources, ['web_search']);
    assert.equal(r.answer, 'React 19.2 is the latest stable version [1] (released October 2025); it runs on Node.js 20 or newer.', 'not rewritten (e.g. "Node.js" is kept)');
    assert.deepEqual(r.citations.map((c) => c.url), ['https://react.dev/versions']);
    assert.equal(r.confidence, 'medium', 'one source is medium confidence');
  });

  test('4. "technology industry this week" runs Google Search', async () => {
    const r = await ask('What happened in the technology industry this week?');
    assert.deepEqual(r.route.sources, ['web_search']);
    assert.equal(r.webSearch.searched, true);
    assert.equal(r.citations.length, 2);
  });

  test('5. "What is UdyogConnect?" is answered from project knowledge, never searched', async () => {
    const r = await ask('What is UdyogConnect?');
    assert.equal(stub.calls.length, 0);
    assert.ok(r.route.sources.includes('project_knowledge'));
    assert.ok(!r.route.sources.includes('web_search'));
    assert.match(r.answer, /marketplace that connects customers with local businesses/);
  });

  test('6. "Which business has the highest rating?" reads the real database, never searched', async () => {
    const r = await ask('Which business has the highest rating?');
    assert.equal(stub.calls.length, 0);
    assert.ok(r.route.sources.includes('live_data'));
    assert.match(r.answer, /Himalayan Momo House/);
    assert.ok(r.evidence.some((e) => e.kind === 'live_data' || /businesses/.test(e.source || '')));
  });

  test('7. "What is the current website status?" runs a live health check, never searched', async () => {
    const r = await ask('What is the current website status?');
    assert.equal(stub.calls.length, 0);
    assert.equal(r.route.method, 'health');
    assert.deepEqual(r.route.sources, ['live_data']);
    assert.equal(r.answerMode, 'health_check');
    assert.match(r.answer, /up|online|reachable/i);
  });

  test('small talk never searches', async () => {
    const r = await ask('Hello');
    assert.equal(stub.calls.length, 0);
    assert.equal(r.status, 'success');
  });

  test('a follow-up to a web answer continues the research with the conversation', async () => {
    const a = await ask('What is the latest AI news?');
    const b = await ask('What about Google?', { conversationId: a.conversationId });
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(b.route.sources, ['web_search']);
    assert.ok(b.route.intents.includes('FOLLOW_UP'));
    assert.match(stub.calls[1].params.input, /User: What is the latest AI news\?/);
    assert.match(stub.calls[1].params.input, /QUESTION: What about Google\?/);
  });
});

describe('quality, terms and limits', () => {
  test('grounded results are never cached: the same question searches again', async () => {
    const stub = gemini(aiNews);
    googleSearch.setClientForTesting(stub);
    await ask('What is the latest AI news?');
    await ask('What is the latest AI news?');
    assert.equal(stub.calls.length, 2);
    assert.equal(googleSearch.status().resultCaching, false);
  });

  test('URLs Google did not return are removed from the answer', async () => {
    googleSearch.setClientForTesting(gemini(() => groundedInteraction('New models shipped. More at https://made-up.example.com/ai.', [['New models shipped', 'https://news.example.com/ai-models', 'Example News']])));
    const r = await ask('What is the latest AI news?');
    assert.ok(!r.answer.includes('made-up.example.com'));
    assert.ok(r.limitations.some((l) => /not backed by a retrieved source were removed/.test(l)));
    assert.deepEqual(r.citations.map((c) => c.url), ['https://news.example.com/ai-models']);
  });

  test('a required search that returns no sources is reported as unverified', async () => {
    googleSearch.setClientForTesting(gemini(() => plainInteraction('I could not find reliable information about that.')));
    const r = await ask('What is the latest AI news?');
    assert.equal(r.status, 'insufficient_data');
    assert.ok(r.limitations.some((l) => /without running a Google Search/.test(l)));
  });

  test('the daily search limit is enforced before calling Google', async () => {
    process.env.GEMINI_SEARCH_DAILY_LIMIT = '1';
    const stub = gemini(aiNews);
    googleSearch.setClientForTesting(stub);
    assert.equal((await ask('What is the latest AI news?')).status, 'success');
    const r = await ask('What is the latest AI news?');
    assert.equal(stub.calls.length, 1);
    assert.equal(r.status, 'insufficient_data');
    assert.equal(r.errorKind, 'quota');
    assert.match(r.answer, /search quota has been reached/);
  });

  test('an unavailable research model falls back and cools down', async () => {
    const stub = gemini((params) => {
      if (params.model === 'gemini-3.8-flash') throw apiError(404, 'Model not available: gemini-3.8-flash');
      return aiNews();
    });
    googleSearch.setClientForTesting(stub);
    const r = await ask('What is the latest AI news?');
    assert.equal(r.status, 'success');
    assert.equal(r.webSearch.model, 'gemini-3.5-flash-lite');
    assert.equal(r.webSearch.fallbackFrom, 'gemini-3.8-flash');
    assert.deepEqual(stub.calls.map((c) => c.params.model), ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
    await ask('What happened in the technology industry this week?');
    assert.equal(stub.calls.at(-1).params.model, 'gemini-3.5-flash-lite');
    assert.equal(stub.calls.length, 3, 'the unavailable model is skipped while it cools down');
    assert.ok(googleSearch.status().cooldowns.some((c) => c.model === 'gemini-3.8-flash'));
  });

  test('timeouts and invalid keys fail honestly without leaking details', async () => {
    googleSearch.setClientForTesting(gemini(() => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); }));
    const t = await ask('What is the latest AI news?');
    assert.equal(t.status, 'insufficient_data');
    assert.equal(t.errorKind, 'timeout');
    assert.match(t.answer, /took too long/);

    googleSearch.resetForTesting();
    googleSearch.setClientForTesting(gemini(() => { throw apiError(400, 'API key not valid. Please pass a valid API key.', { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] }); }));
    const k = await ask('What is the latest AI news?');
    assert.equal(k.errorKind, 'auth');
    assert.deepEqual(k.needsConfiguration, ['GEMINI_API_KEY']);
  });

  test('search usage is tracked per project', async () => {
    googleSearch.setClientForTesting(gemini(aiNews));
    await ask('What is the latest AI news?');
    const { body } = await api.call('GET', `/api/v1/projects/${p.id}/assistant`, { token });
    assert.ok(body.metrics.googleSearch.requests >= 1);
    assert.ok(body.metrics.googleSearch.grounded >= 1);
    assert.equal(body.webSearch.provider, 'google');
    assert.equal(body.webSearch.google.resultCaching, false);
    assert.deepEqual(body.ai, { generalKnowledge: true, languageModel: false });
    assert.ok(!JSON.stringify(body).includes('GEMINI_API_KEY='), 'the key is never returned');
    const health = await fetch(`${api.base}/health`).then((r) => r.json());
    assert.equal(health.google, true);
    assert.equal(health.webSearch, true);
  });
});

describe('alongside the main language model and project tools', () => {
  let seen;
  const reply = (message) => ({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  const toolCall = (calls) => ({ role: 'assistant', content: '', tool_calls: calls.map(([name, args], i) => ({ id: `call_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });

  before(() => {
    seen = [];
    llm.setClientForTesting({
      chat: { completions: { create: async (params) => {
        seen.push({ ...params, messages: [...params.messages] });
        const last = params.messages.at(-1);
        if (last.role === 'tool') return reply({ role: 'assistant', content: 'Done.' });
        if (/eSewa/.test(last.content)) {
          // Web search listed first: the agent still runs the project lookup before handing off.
          return reply(toolCall([['web_search', { query: 'eSewa new features 2026' }], ['search_project', { query: 'eSewa payments' }]]));
        }
        return reply({ role: 'assistant', content: 'UdyogConnect is a local business marketplace.' });
      } } },
      responses: { create: async () => { throw new Error('OpenAI web search must not be used when Google Search is configured'); } },
      embeddings: { create: async () => { throw new Error('embeddings disabled in tests'); } },
    });
  });
  after(() => llm.setClientForTesting(null));

  test('mixed question: project facts first, then one grounded Google answer with that context', async () => {
    const stub = gemini(() => groundedInteraction('eSewa added QR merchant payments in 2026. UdyogConnect already accepts eSewa wallet payments.', [['QR merchant payments', 'https://esewa.example.com/news', 'eSewa news']], ['eSewa new features 2026']));
    googleSearch.setClientForTesting(stub);
    const r = await ask('Does UdyogConnect support eSewa, and what new features did eSewa announce recently?');
    assert.equal(stub.calls.length, 1);
    const input = stub.calls[0].params.input;
    assert.match(input, /PROJECT CONTEXT[\s\S]*docs\/payments\.md[\s\S]*eSewa wallet payments/);
    assert.match(input, /INTERPRETED AS: eSewa new features 2026/);
    assert.equal(r.answer, 'eSewa added QR merchant payments [1] in 2026. UdyogConnect already accepts eSewa wallet payments.');
    assert.ok(r.route.sources.includes('project_knowledge') && r.route.sources.includes('web_search'));
    assert.ok(r.toolCalls[0].startsWith('search_project'), 'project lookup ran before the web hand-off');
    assert.equal(r.intent, 'mixed');
    assert.equal(r.citations[0].url, 'https://esewa.example.com/news');
  });

  test('grounded answers are not passed to other models; only the topic is', async () => {
    googleSearch.setClientForTesting(gemini(aiNews));
    const a = await ask('What is the latest AI news?');
    assert.deepEqual(a.route.sources, ['web_search']);
    await ask('What is UdyogConnect?', { conversationId: a.conversationId });
    const messages = seen.at(-1).messages;
    assert.ok(!messages.some((m) => (m.content || '').includes('released new reasoning models')), 'grounded text stays out of the OpenAI conversation');
    assert.ok(messages.some((m) => m.role === 'assistant' && /Answered with live Google Search results/.test(m.content)));
  });

  test('the agent is not offered web search for the project database', async () => {
    const stub = gemini(aiNews);
    googleSearch.setClientForTesting(stub);
    const from = seen.length;
    const r = await ask('Which business has the highest rating?');
    assert.equal(stub.calls.length, 0);
    assert.ok(r.route.sources.includes('live_data'));
    assert.match(r.answer, /Himalayan Momo House/);
    assert.ok(seen.slice(from).every((c) => !(c.tools || []).some((t) => t.function.name === 'web_search')));
  });
});
