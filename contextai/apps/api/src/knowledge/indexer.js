// Indexing runs as a tracked background job so large repositories never block a request.
// Jobs run in-process; a Redis/BullMQ queue can replace `schedule` without changing callers.
import { db } from '../lib/db.js';
import { analyzeProject, chunkProject, isIndexable } from '../understanding/analyzer.js';
import { fetchRepository } from '../understanding/github.js';
import { crawlWebsite } from '../understanding/crawler.js';
import { scheduleEmbeddings } from '../assistant/embeddings.js';
import { redactSecrets } from '../assistant/guard.js';

const running = new Set();

function hasCoverageWarnings(skipped = {}) {
  const nonEmpty = (value) => Array.isArray(value) ? value.length > 0 : Boolean(value);
  return [
    skipped.failed, skipped.tooLarge, skipped.overFileLimit, skipped.truncatedTree,
    skipped.binary, skipped.notFetched, skipped.blocked, skipped.authRequired,
    skipped.javascriptRequired, skipped.jsRendered, skipped.overPageLimit,
    skipped.discoveryErrors, skipped.syncWarning,
    ...(skipped.pages || []).filter((page) => ['partial', 'failed', 'blocked', 'authentication_required', 'javascript_required'].includes(page.status)),
  ].some(nonEmpty) || Boolean(skipped.browser?.warning && (skipped.javascriptRequired?.length || skipped.jsRendered?.length));
}

function projectStatus(projectId, currentJobId) {
  const otherJobRunning = db.listJobs([projectId], 100).some((job) =>
    job.id !== currentJobId && ['queued', 'running'].includes(job.status));
  if (otherJobRunning) return 'indexing';
  const profile = db.getProfile(projectId);
  return Object.values(profile?.parts || {}).some((part) => hasCoverageWarnings(part.skipped))
    ? 'completed_with_warnings'
    : profile ? 'indexed' : 'failed';
}

function schedule(job, work) {
  running.add(job.id);
  setImmediate(async () => {
    db.updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });
    try {
      const result = await work((progress) => db.updateJob(job.id, { progress }));
      const status = result?.status === 'completed_with_warnings' ? 'completed_with_warnings' : 'completed';
      db.updateJob(job.id, { status, finishedAt: new Date().toISOString(), result });
      db.updateProject(job.projectId, { indexingStatus: projectStatus(job.projectId, job.id), indexingError: null });
    } catch (e) {
      db.updateJob(job.id, { status: 'failed', finishedAt: new Date().toISOString(), error: e.message, ...(e.coverage ? { coverage: e.coverage } : {}) });
      // A failed source must not mark the project failed while another source is still usable.
      const anotherJobRunning = db.listJobs([job.projectId], 100).some((other) =>
        other.id !== job.id && ['queued', 'running'].includes(other.status));
      db.updateProject(job.projectId, {
        indexingStatus: anotherJobRunning ? 'indexing' : db.getProfile(job.projectId) ? 'completed_with_warnings' : 'failed',
        indexingError: e.message,
      });
      db.addAudit({ projectId: job.projectId, actor: job.actor, action: 'index', target: job.kind, status: 'error', error: e.message });
    } finally {
      running.delete(job.id);
    }
  });
  return job;
}

const uniq = (list) => {
  const seen = new Set();
  return list.filter((x) => { const k = typeof x === 'string' ? x : JSON.stringify(x); return seen.has(k) ? false : (seen.add(k), true); });
};

// Code (GitHub or upload) and the live website are indexed independently and combined here,
// so either one can be re-indexed without discarding what the other contributed.
export function mergeArchitectures(parts) {
  const list = parts.filter(Boolean);
  if (list.length <= 1) return list[0] || null;
  const merged = {};
  for (const a of list) {
    for (const [key, value] of Object.entries(a)) {
      if (Array.isArray(value)) merged[key] = uniq([...(merged[key] || []), ...value]);
      else if (value && typeof value === 'object') {
        merged[key] ||= {};
        for (const [k, v] of Object.entries(value)) merged[key][k] = Array.isArray(v) ? uniq([...(merged[key][k] || []), ...v]) : v;
      } else if (!(key in merged)) merged[key] = value;
    }
  }
  if (merged.stack?.frontend?.length > 1) merged.stack.frontend = merged.stack.frontend.filter((f) => f !== 'Static HTML site');
  merged.modules = [...merged.modules].sort((x, y) => y.fileCount - x.fileCount).slice(0, 25);
  const weights = new Map();
  for (const a of list) for (const e of a.entities || []) weights.set(e.name, (weights.get(e.name) || 0) + e.weight);
  merged.entities = [...weights.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([name, weight]) => ({ name, weight }));
  merged.fileCount = list.reduce((s, a) => s + (a.fileCount || 0), 0);
  merged.analyzedAt = list.map((a) => a.analyzedAt).sort().at(-1);
  return merged;
}

const legacyParts = (profile) => (profile?.architecture ? { [profile.source === 'website' ? 'website' : 'code']: { architecture: profile.architecture, repository: profile.repository, source: profile.source, skipped: profile.skipped || {}, indexedAt: profile.updatedAt } } : {});

function combineProfile(parts) {
  const { code, website } = parts;
  return {
    parts,
    architecture: mergeArchitectures([code?.architecture, website?.architecture]),
    repository: code?.repository || null,
    website: website?.repository || null,
    source: [code?.source, website?.source].filter(Boolean).join('+'),
    // A JavaScript-rendered site is only a gap when there is no code to fall back on.
    skipped: { ...website?.skipped, ...code?.skipped, jsRendered: code ? [] : website?.skipped?.jsRendered || [] },
  };
}

export function indexFiles({ projectId, files, repository = null, source = 'upload', skipped = {}, origin = 'code' }) {
  const usable = files.filter((f) => f?.path && typeof f.content === 'string' && isIndexable(f.path));
  if (!usable.length) throw Object.assign(new Error('No indexable files (code, docs or config) were provided'), { status: 400 });
  const redacted = [];
  const safeFiles = usable.map((file) => {
    let content = redactSecrets(file.content);
    content = content.replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key|database[_-]?url|connection[_-]?string)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;}\]]+)/gi,
      (match, key) => { redacted.push(file.path); return `${key}"[redacted]"`; },
    );
    if (content !== file.content) redacted.push(file.path);
    return { ...file, content };
  });
  const sourceSkipped = {
    ...skipped,
    ...(redacted.length ? { redactedFiles: [...new Set(redacted)], redactedFileCount: new Set(redacted).size } : {}),
    ...(files.length > usable.length ? { excludedByPolicyCount: files.length - usable.length } : {}),
  };
  const architecture = analyzeProject(safeFiles);
  const chunks = chunkProject(safeFiles, architecture).map((c) => ({
    ...c,
    origin,
    sourceVersion: repository?.commit || repository?.url || null,
    ...(origin === 'website' && c.source === 'architecture-summary' ? { source: 'website-summary' } : {}),
  }));
  const existing = db.getProfile(projectId);
  const coverage = sourceSkipped.counts || {
    discovered: sourceSkipped.discoveredFiles ?? files.length,
    eligible: sourceSkipped.eligibleFiles ?? usable.length,
    fetched: sourceSkipped.fetchedFiles ?? files.length,
    indexed: usable.length,
    failed: (sourceSkipped.failed || []).length,
    skipped: (sourceSkipped.tooLarge || []).length + (sourceSkipped.overFileLimit || []).length + (sourceSkipped.binary || []).length,
  };
  const warningStatus = hasCoverageWarnings(sourceSkipped) ? 'completed_with_warnings' : 'indexed';
  const parts = { ...(existing?.parts || legacyParts(existing)), [origin]: { architecture, repository, source, skipped: sourceSkipped, coverage, indexedAt: new Date().toISOString() } };
  db.upsertProfile(projectId, combineProfile(parts));
  db.replaceChunks(projectId, chunks, origin);
  scheduleEmbeddings(projectId);
  db.updateProject(projectId, {
    indexingStatus: warningStatus,
    indexingError: null,
    lastIndexedAt: new Date().toISOString(),
    fileCount: Object.values(parts).reduce((s, p) => s + (p.architecture?.fileCount || 0), 0),
    ...(origin === 'code' && repository ? { repository } : {}),
  });
  return {
    filesIndexed: usable.length,
    filesIgnored: files.length - usable.length,
    chunks: chunks.length,
    routes: architecture.routes.length,
    models: architecture.models.length,
    status: warningStatus === 'indexed' ? 'completed' : warningStatus,
    coverage,
    skipped: sourceSkipped,
  };
}

export function queueUploadIndex({ projectId, files, actor }) {
  const job = db.createJob({ projectId, actor, kind: 'upload-index' });
  db.updateProject(projectId, { indexingStatus: 'indexing' });
  return schedule(job, async () => indexFiles({ projectId, files }));
}

export function queueGithubIndex({ projectId, repositoryUrl, branch, token, actor }) {
  const job = db.createJob({ projectId, actor, kind: 'github-index', repositoryUrl });
  db.updateProject(projectId, { indexingStatus: 'indexing' });
  return schedule(job, async (progress) => {
    const snapshot = await fetchRepository({ repositoryUrl, branch, token, onProgress: progress });
    const incomplete = snapshot.skipped.failed.length || snapshot.skipped.tooLarge.length ||
      snapshot.skipped.overFileLimit.length || snapshot.skipped.truncatedTree;
    const existing = db.getProfile(projectId);
    const existingParts = existing?.parts || legacyParts(existing);
    if (incomplete && existingParts.code) {
      const attemptedAt = new Date().toISOString();
      const warning = {
        attemptedAt,
        attemptedCommit: snapshot.repository.commit,
        reason: 'Incomplete GitHub snapshot; the previous indexed commit was retained.',
        coverage: snapshot.skipped,
      };
      const parts = {
        ...existingParts,
        code: {
          ...existingParts.code,
          syncWarning: warning,
          skipped: { ...(existingParts.code.skipped || {}), syncWarning: warning },
        },
      };
      db.upsertProfile(projectId, combineProfile(parts));
      db.addAudit({ projectId, actor, action: 'index', target: snapshot.repository.fullName, status: 'warning', error: warning.reason });
      return {
        status: 'completed_with_warnings',
        retainedPreviousIndex: true,
        repository: existingParts.code.repository,
        attemptedRepository: snapshot.repository,
        coverage: {
          discovered: snapshot.skipped.discoveredFiles,
          eligible: snapshot.skipped.eligibleFiles,
          fetched: snapshot.skipped.fetchedFiles,
          indexed: existingParts.code.architecture?.fileCount || 0,
          failed: snapshot.skipped.failed.length,
        },
        skipped: snapshot.skipped,
      };
    }
    if (!snapshot.files.length) {
      const error = Object.assign(new Error('The repository snapshot contained no indexable files'), { status: 422 });
      error.coverage = snapshot.skipped;
      throw error;
    }
    const result = indexFiles({ projectId, files: snapshot.files, repository: snapshot.repository, source: 'github', skipped: snapshot.skipped });
    db.addAudit({ projectId, actor, action: 'index', target: snapshot.repository.fullName, status: 'success' });
    return { ...result, repository: snapshot.repository };
  });
}

export function queueWebsiteIndex({ projectId, url, actor }) {
  const job = db.createJob({ projectId, actor, kind: 'website-crawl', repositoryUrl: url });
  db.updateProject(projectId, { indexingStatus: 'indexing' });
  return schedule(job, async (progress) => {
    const crawl = await crawlWebsite({ url, onProgress: progress });
    const incomplete = hasCoverageWarnings(crawl.skipped);
    const existing = db.getProfile(projectId);
    const existingParts = existing?.parts || legacyParts(existing);
    if (incomplete && existingParts.website) {
      const attemptedRepository = { fullName: crawl.site.url, url: crawl.site.url, kind: 'website' };
      const warning = {
        attemptedAt: new Date().toISOString(),
        reason: 'Incomplete website crawl; the previous indexed website snapshot was retained.',
        coverage: crawl.coverage,
      };
      const parts = {
        ...existingParts,
        website: {
          ...existingParts.website,
          syncWarning: warning,
          skipped: { ...(existingParts.website.skipped || {}), syncWarning: warning },
        },
      };
      db.upsertProfile(projectId, combineProfile(parts));
      db.addAudit({ projectId, actor, action: 'index', target: crawl.site.url, status: 'warning', error: warning.reason });
      return {
        status: 'completed_with_warnings',
        retainedPreviousIndex: true,
        repository: existingParts.website.repository,
        attemptedRepository,
        coverage: {
          ...crawl.coverage.counts,
          indexed: existingParts.website.architecture?.fileCount || 0,
        },
        skipped: crawl.skipped,
      };
    }
    if (!crawl.files.length) {
      const error = Object.assign(new Error('The website crawl found no indexable pages'), { status: 422 });
      error.coverage = crawl.coverage;
      throw error;
    }
    const result = indexFiles({ projectId, files: crawl.files, repository: { fullName: crawl.site.url, url: crawl.site.url, kind: 'website' }, source: 'website', skipped: crawl.skipped, origin: 'website' });
    db.addAudit({ projectId, actor, action: 'index', target: crawl.site.url, status: 'success' });
    return { ...result, site: crawl.site };
  });
}

export const isJobRunning = (jobId) => running.has(jobId);
