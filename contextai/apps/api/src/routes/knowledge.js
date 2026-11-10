import express from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireProject } from '../middleware/auth.js';
import { queueGithubIndex, queueUploadIndex, queueWebsiteIndex } from '../knowledge/indexer.js';
import { searchKnowledge } from '../knowledge/search.js';
import { parseRepoUrl } from '../understanding/github.js';
import { assertPublicUrl } from '../lib/netguard.js';

export const knowledgeRouter = express.Router();

const uploadSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1).max(400), content: z.string().max(500_000) })).min(1).max(2000),
});

knowledgeRouter.post('/:id/knowledge/index', requireProject('manage'), (req, res, next) => {
  try {
    const { files } = uploadSchema.parse(req.body);
    const job = queueUploadIndex({ projectId: req.project.id, files, actor: req.actor });
    res.status(202).json({ job });
  } catch (e) { next(e); }
});

knowledgeRouter.post('/:id/connect/github', requireProject('manage'), (req, res, next) => {
  try {
    const { repositoryUrl, branch, token } = z.object({ repositoryUrl: z.string().min(3), branch: z.string().max(200).optional(), token: z.string().max(300).optional() }).parse(req.body);
    const repo = parseRepoUrl(repositoryUrl);
    const ref = branch || repo.branch || undefined;
    db.updateProject(req.project.id, { repository: { fullName: repo.fullName, url: `https://github.com/${repo.fullName}`, branch: ref || null } });
    const job = queueGithubIndex({ projectId: req.project.id, repositoryUrl, branch: ref, token, actor: req.actor });
    res.status(202).json({ job });
  } catch (e) { next(e); }
});

knowledgeRouter.post('/:id/connect/website', requireProject('manage'), (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().url() }).parse(req.body);
    assertPublicUrl(url);
    db.updateProject(req.project.id, { websiteUrl: url });
    const job = queueWebsiteIndex({ projectId: req.project.id, url, actor: req.actor });
    res.status(202).json({ job });
  } catch (e) { next(e); }
});

knowledgeRouter.get('/:id/knowledge/search', requireProject('search'), (req, res) => {
  const q = String(req.query.q || '').slice(0, 500);
  if (!q) return res.status(400).json({ error: 'q is required' });
  const results = searchKnowledge({ projectId: req.project.id, query: q, type: req.query.type, limit: Math.min(Number(req.query.limit) || 8, 25) });
  res.json({ query: q, count: results.length, results });
});

knowledgeRouter.get('/:id/architecture', requireProject('read'), (req, res) => {
  const profile = db.getProfile(req.project.id);
  if (!profile) return res.status(404).json({ error: 'Project has not been indexed yet' });
  res.json({ architecture: profile.architecture, repository: profile.repository, website: profile.website || null, source: profile.source });
});
