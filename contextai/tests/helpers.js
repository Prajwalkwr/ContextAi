import fs from 'fs';
import os from 'os';
import path from 'path';

export async function startApi() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'contextai-test-'));
  process.env.JWT_SECRET = 'test-secret-that-is-definitely-longer-than-32-chars';
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32-characters';
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.ASK_RATE_LIMIT_MAX = '100000';
  process.env.EMBEDDINGS_ENABLED = 'false';
  process.env.GITHUB_WEBHOOK_SECRET = 'webhook-secret';
  process.env.ALLOW_PRIVATE_NETWORK = 'true';
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.WEB_SEARCH_PROVIDER;
  const { createApp } = await import('../apps/api/src/app.js');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, { body, token, headers = {} } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function user(email) {
    const r = await call('POST', '/api/v1/auth/register', { body: { email, password: 'password123' } });
    return r.body.token;
  }

  async function project(token, name) {
    const r = await call('POST', '/api/v1/projects', { token, body: { name } });
    return { id: r.body.project.id, ...r.body.credentials };
  }

  async function waitForJob(token, projectId, jobId) {
    for (let i = 0; i < 600; i++) {
      const { body } = await call('GET', `/api/v1/projects/${projectId}/jobs`, { token });
      const job = body.jobs.find((j) => j.id === jobId);
      if (job && ['completed', 'completed_with_warnings', 'failed'].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('job did not finish');
  }

  const { closeAllConnections } = await import('../apps/api/src/connectors/index.js');
  const close = async () => { server.close(); await closeAllConnections(); };
  return { base, call, user, project, waitForJob, close };
}

// Small deterministic generators for clearly synthetic test datasets.
export function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}
