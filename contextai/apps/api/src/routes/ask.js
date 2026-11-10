import express from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { metrics } from '../lib/metrics.js';
import { requireProject, requireUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { investigate } from '../engine/investigate.js';
import { assist } from '../assistant/orchestrator.js';
import { assistantSettingsSchema, settingsOf } from '../assistant/projectConfig.js';
import { webProvider } from '../assistant/searchPolicy.js';
import { googleSearch } from '../lib/googleSearch.js';
import { llm } from '../lib/llm.js';

export const askRouter = express.Router();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const askSchema = z.object({
  question: z.string().trim().min(2).max(1000),
  timeRange: z.object({ from: date, to: date }).optional(),
  conversationId: z.string().regex(/^conv_[a-f0-9]{16}$/).optional(),
  history: z.array(z.object({ question: z.string().max(1000), answer: z.string().max(4000).optional() })).max(10).optional(),
  context: z.object({ userId: z.string().max(100).optional(), userToken: z.string().max(2000).optional() }).passthrough().optional(),
});

// LLM-backed requests cost money, so they get a tighter per-caller budget than the rest of the API.
const askLimit = rateLimit({ max: Number(process.env.ASK_RATE_LIMIT_MAX) || 30, keyOf: (req) => `ask:${req.headers['x-project-key'] || req.headers['x-secret-key'] || req.headers.authorization || req.ip}` });

// Who the end user is. Server-side callers (secret key, developer token) are trusted to assert it;
// browser callers (public key) must present a token signed with the project's user-token secret.
function resolveIdentity(req, context) {
  if (!context) return null;
  if (req.auth.type !== 'publicKey') return context.userId ? { userId: context.userId, verifiedBy: req.auth.type } : null;
  if (!context.userToken) return null;
  const secret = req.project.assistant?.userTokenSecret ? decrypt(req.project.assistant.userTokenSecret) : null;
  if (!secret) throw Object.assign(new Error('This project has no user-token secret configured'), { status: 401 });
  try {
    const claims = jwt.verify(context.userToken, secret, { algorithms: ['HS256'], audience: req.project.id });
    if (!claims.sub) throw new Error('missing sub');
    return { userId: String(claims.sub).slice(0, 100), verifiedBy: 'user_token' };
  } catch {
    throw Object.assign(new Error('Invalid or expired user token'), { status: 401 });
  }
}

askRouter.post('/:id/ask', requireProject('ask'), askLimit, async (req, res, next) => {
  try {
    const body = askSchema.parse(req.body);
    const identity = resolveIdentity(req, body.context);
    const actor = identity ? `${req.actor}:${identity.userId}` : body.context?.userId && req.auth.type !== 'publicKey' ? `${req.actor}:${body.context.userId}` : req.actor;
    res.json(await assist({ project: req.project, question: body.question, timeRange: body.timeRange, conversationId: body.conversationId, history: body.history, actor, identity }));
  } catch (e) { next(e); }
});

// The deterministic engine on its own: project data and code only, no routing or web access.
const engineHandler = (shape) => async (req, res, next) => {
  try {
    const body = askSchema.parse(shape ? shape(req.body) : req.body);
    const actor = body.context?.userId ? `${req.actor}:${body.context.userId}` : req.actor;
    res.json(await investigate({ project: req.project, question: body.question, timeRange: body.timeRange, actor }));
  } catch (e) { next(e); }
};

askRouter.post('/:id/investigate', requireProject('ask'), engineHandler());
askRouter.post('/:id/report', requireProject('ask'), engineHandler((b) => ({
  ...b,
  question: b.question || `Summarise ${String(b.topic || 'overall activity').slice(0, 200)}${b.timeRange ? '' : ' this month'}`,
})));

const publicSettings = (project) => {
  const { userTokenSecret, ...rest } = settingsOf(project);
  return { ...rest, userTokenSecretConfigured: !!project.assistant?.userTokenSecret };
};

askRouter.get('/:id/assistant', requireProject('read'), (req, res) => {
  const settings = settingsOf(req.project);
  const provider = webProvider(settings);
  res.json({
    settings: publicSettings(req.project),
    ai: {
      generalKnowledge: settings.allowGeneralKnowledge && (llm.isEnabled() || provider === 'google'),
      languageModel: llm.isEnabled(),
    },
    metrics: metrics.snapshot(req.project.id),
    webSearch: { provider, google: googleSearch.status() },
  });
});

askRouter.patch('/:id/assistant', requireUser, requireProject('manage'), (req, res, next) => {
  try {
    const patch = assistantSettingsSchema.parse(req.body);
    const current = req.project.assistant || {};
    const next = { ...current, ...patch, searchConfiguration: { ...(current.searchConfiguration || {}), ...(patch.searchConfiguration || {}) } };
    const project = db.updateProject(req.project.id, { assistant: next });
    db.addAudit({ projectId: project.id, actor: req.actor, action: 'assistant.settings', target: Object.keys(patch).join(','), status: 'success' });
    res.json({ settings: publicSettings(project) });
  } catch (e) { next(e); }
});

// Returns the secret once; the host application signs end-user tokens with it (HS256, aud = project id).
askRouter.post('/:id/assistant/user-token-secret', requireUser, requireProject('manage'), (req, res) => {
  const secret = randomBytes(32).toString('hex');
  db.updateProject(req.project.id, { assistant: { ...(req.project.assistant || {}), userTokenSecret: encrypt(secret) } });
  db.addAudit({ projectId: req.project.id, actor: req.actor, action: 'assistant.user_token_secret', target: 'rotate', status: 'success' });
  res.status(201).json({ userTokenSecret: secret, algorithm: 'HS256', audience: req.project.id });
});
