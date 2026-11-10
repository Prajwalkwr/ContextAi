import express from 'express';
import { db } from '../lib/db.js';
import { verifyHmac } from '../lib/crypto.js';
import { queueGithubIndex } from '../knowledge/indexer.js';

export const webhookRouter = express.Router();

// GitHub push webhook: verified with X-Hub-Signature-256, then re-indexes every project linked to the repo.
webhookRouter.post('/github', (req, res) => {
  if (!verifyHmac(process.env.GITHUB_WEBHOOK_SECRET, req.rawBody || Buffer.alloc(0), req.headers['x-hub-signature-256'])) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (req.headers['x-github-event'] === 'ping') return res.json({ ok: true });
  if (req.headers['x-github-event'] !== 'push') return res.json({ ignored: true });
  const fullName = req.body?.repository?.full_name;
  const branch = String(req.body?.ref || '').replace('refs/heads/', '');
  const projects = fullName ? db.findProjectsByRepo(fullName).filter((p) => !p.repository.branch || p.repository.branch === branch) : [];
  const jobs = projects.map((p) => queueGithubIndex({ projectId: p.id, repositoryUrl: fullName, branch, actor: 'github-webhook' }));
  res.status(202).json({ queued: jobs.map((j) => j.id) });
});
