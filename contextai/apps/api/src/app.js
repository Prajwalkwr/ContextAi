import express from 'express';
import cors from 'cors';
import { authenticate } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.js';
import { projectRouter } from './routes/projects.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { integrationRouter } from './routes/integrations.js';
import { askRouter } from './routes/ask.js';
import { webhookRouter } from './routes/webhooks.js';
import { llm } from './lib/llm.js';
import { googleSearch } from './lib/googleSearch.js';
import { webProvider } from './assistant/searchPolicy.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const origins = process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins?.length ? origins : true }));
  app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (req, res) => res.json({
    status: 'ok',
    service: 'contextai-api',
    llm: llm.isEnabled(),
    google: googleSearch.isEnabled(),
    webSearch: !!webProvider(),
  }));

  app.use('/api/v1', rateLimit());
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/webhooks', webhookRouter);
  app.use('/api/v1/projects', authenticate, projectRouter, knowledgeRouter, integrationRouter, askRouter);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
