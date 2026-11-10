import dotenv from 'dotenv';
import path from 'path';
import { createApp } from './app.js';
import { closeAllConnections } from './connectors/index.js';
import { llm } from './lib/llm.js';
import { googleSearch } from './lib/googleSearch.js';
import { webProvider } from './assistant/searchPolicy.js';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config();

for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY']) {
  if (!process.env[key]) {
    console.error(`[contextai] ${key} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT) || 4000;
const server = createApp().listen(port, () => {
  console.log(`[contextai] API listening on http://localhost:${port}`);
  console.log(`[contextai] Answer mode: ${llm.isEnabled()
    ? `conversational agent (${llm.provider()} · ${process.env.OPENAI_MODEL || 'gpt-4o-mini'})`
    : googleSearch.isEnabled()
      ? 'Gemini general answers + deterministic project answers'
      : 'deterministic (set GEMINI_API_KEY for Gemini general answers, or OPENAI_API_KEY / LLM_BASE_URL for the conversational agent)'}`);
  const web = webProvider();
  const g = googleSearch.config();
  console.log(`[contextai] Web search: ${web === 'google' ? `Google Search grounding (Gemini ${g.researchModel} / ${g.fastModel}, fallback ${g.fallbackModel || 'none'}, ${g.dailyLimit} requests/day)`
    : web === 'openai' ? 'OpenAI hosted web search' : 'off (set GEMINI_API_KEY for Google Search grounding)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => { await closeAllConnections(); process.exit(0); }));
}
