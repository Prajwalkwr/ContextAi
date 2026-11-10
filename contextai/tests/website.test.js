import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startApi } from './helpers.js';
import { fetchWithTimeout } from '../apps/api/src/lib/netguard.js';
import { parseRepoUrl } from '../apps/api/src/understanding/github.js';
import { crawlWebsite } from '../apps/api/src/understanding/crawler.js';

let server;
let api;
let base;
let visited = [];
let methods = [];

before(async () => {
  process.env.ALLOW_PRIVATE_NETWORK = 'true';
  server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    visited.push(url.pathname);
    methods.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`User-agent: *\nDisallow: /private\nSitemap: ${base}/sitemap-index.xml\n`);
      return;
    }
    if (url.pathname === '/sitemap-index.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<sitemapindex><sitemap><loc>${base}/sitemap.xml</loc></sitemap></sitemapindex>`);
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<urlset>${['/', '/about', '/products', '/duplicate', '/private', '/login', '/failure', '/delayed'].map((path) => `<url><loc>${base}${path}</loc></url>`).join('')}</urlset>`);
      return;
    }
    if (url.pathname === '/private') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Should never be requested</h1>');
      return;
    }
    if (url.pathname === '/login') {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<h1>Login required</h1>');
      return;
    }
    if (url.pathname === '/failure') {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<h1>Temporarily unavailable</h1>');
      return;
    }
    if (url.pathname === '/api/get-product-details') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ description: 'Verified product data from a read-only JSON API.' }));
      }, 2800);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Context storefront</title></head><body><div id="root"></div><script>
      const path = location.pathname;
      const pages = {
        '/': '<h1>Home catalog</h1><p>Browse handcrafted items from local makers.</p><a href="/extra">More details</a>',
        '/about': '<h1>About Context</h1><p>Members can create verified profiles with saved preferences.</p><form><input name="email"><button type="submit">Create account</button></form>',
        '/products': '<h1>Product inventory</h1><p>Filter handcrafted goods by material and availability.</p>',
        '/duplicate': '<h1>About Context</h1><p>Members can create verified profiles with saved preferences.</p><form><input name="email"><button type="submit">Create account</button></form>',
        '/extra': '<h1>Warranty details</h1><p>Each item includes a one-year repair warranty.</p>',
        '/delayed': '<h1>Delayed product</h1><p>Product data appears after the client-side request resolves.</p>'
      };
      if (path === '/delayed') {
        document.querySelector('#root').innerHTML = '<h1>Product loading</h1><p>Price Rs NaN while data loads.</p>';
        fetch('/api/get-product-details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 'example' }) })
          .then(response => response.json())
          .then(data => { document.querySelector('#root').innerHTML = pages[path] + '<p>' + data.description + '</p>'; });
        fetch('/api/create-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 'example' }) }).catch(() => {});
      }
      else document.querySelector('#root').innerHTML = pages[path] || '<h1>Page content</h1>';
    </script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  api = await startApi();
});

after(async () => {
  await api?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('discovers sitemap routes, renders JavaScript, and reports blocked, duplicate, and failed pages', async () => {
  visited = [];
  methods = [];
  let result;
  try { result = await crawlWebsite({ url: `${base}/`, maxPages: 20 }); } catch (error) {
    throw new Error(`${error.message} ${JSON.stringify(error.coverage)}`);
  }
  assert.equal(result.site.browserRendered, true);
  assert.ok(result.files.some((file) => file.url.endsWith('/about') && file.text.includes('verified profiles')));
  assert.ok(result.files.some((file) => file.url.endsWith('/products') && file.text.includes('availability')));
  assert.ok(result.files.some((file) => file.url.endsWith('/extra') && file.text.includes('repair warranty')));
  assert.ok(result.files.some((file) => file.url.endsWith('/delayed') && file.text.includes('request resolves')));
  assert.ok(result.files.some((file) => file.url.endsWith('/delayed') && file.text.includes('Verified product data')));
  assert.ok(result.files.find((file) => file.url.endsWith('/about')).page.forms.some((form) => form.inputs.includes('email')));
  assert.ok(result.files.find((file) => file.url.endsWith('/about')).page.controls.some((control) => control.label === 'Create account'));
  assert.ok(result.skipped.duplicates.some((item) => item.url.endsWith('/duplicate')));
  assert.ok(result.skipped.authRequired.some((item) => item.url.endsWith('/login')));
  assert.ok(result.skipped.failed.some((item) => item.url.endsWith('/failure') && item.status === 503));
  assert.ok(result.skipped.blocked.some((item) => item.url.endsWith('/private')));
  assert.ok(!visited.includes('/private'), 'robots-disallowed page was not requested');
  assert.equal(result.coverage.counts.indexed, result.files.length);
  assert.equal(result.files.some((file) => file.text.includes('Should never be requested')), false);
  assert.ok(methods.every((method) => method.startsWith('GET ') || method === 'POST /api/get-product-details'));
  assert.ok(methods.includes('POST /api/get-product-details'));
  assert.ok(!methods.some((method) => method.includes('/api/create-order')), 'mutating endpoints must not be requested');
});

test('website indexing stores page URLs and reports incomplete coverage honestly', async () => {
  const token = await api.user('website-index@example.com');
  const project = await api.project(token, 'Rendered website');
  const queued = await api.call('POST', `/api/v1/projects/${project.id}/connect/website`, {
    token,
    body: { url: base },
  });
  assert.equal(queued.status, 202);
  const job = await api.waitForJob(token, project.id, queued.body.job.id);
  assert.equal(job.status, 'completed_with_warnings');
  assert.equal(job.result.coverage.indexed, 5);
  const detail = await api.call('GET', `/api/v1/projects/${project.id}`, { token });
  assert.equal(detail.body.project.indexingStatus, 'completed_with_warnings');
  assert.ok(detail.body.profile.parts.website.architecture.pages.some((page) => page.url.endsWith('/about')));
  const search = await api.call('GET', `/api/v1/projects/${project.id}/knowledge/search?q=verified+profiles`, { token });
  assert.ok(search.body.results.some((result) => result.url === `${base}/about`));

  const { db } = await import('../apps/api/src/lib/db.js');
  const { queueWebsiteIndex } = await import('../apps/api/src/knowledge/indexer.js');
  const previousChunkIds = db.getChunks(project.id).filter((chunk) => chunk.origin === 'website').map((chunk) => chunk.id);
  const sync = queueWebsiteIndex({ projectId: project.id, url: base, actor: token });
  const syncResult = await api.waitForJob(token, project.id, sync.id);
  assert.equal(syncResult.status, 'completed_with_warnings');
  assert.equal(syncResult.result.retainedPreviousIndex, true);
  assert.deepEqual(db.getChunks(project.id).filter((chunk) => chunk.origin === 'website').map((chunk) => chunk.id), previousChunkIds);
  assert.ok(db.getProfile(project.id).parts.website.skipped.syncWarning);
});

test('large source lines are split without truncation and credential values are redacted', async () => {
  const token = await api.user('source-index@example.com');
  const project = await api.project(token, 'Source coverage');
  const original = `const API_KEY = "sensitive-test-value";\n${'x'.repeat(13000)}`;
  const { indexFiles } = await import('../apps/api/src/knowledge/indexer.js');
  const { db } = await import('../apps/api/src/lib/db.js');
  indexFiles({
    projectId: project.id,
    repository: { fullName: 'example/repo', commit: 'abc123' },
    source: 'github',
    files: [{ path: 'src/long.js', content: original }],
  });
  const chunks = db.getChunks(project.id).filter((chunk) => chunk.source === 'src/long.js');
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 6000));
  assert.ok(chunks.every((chunk) => chunk.sourceVersion === 'abc123'));
  assert.ok(chunks.every((chunk) => !chunk.content.includes('sensitive-test-value')));
  assert.ok(chunks.some((chunk) => chunk.content.includes('[redacted]')));
  assert.equal(chunks.reduce((count, chunk) => count + (chunk.content.match(/x/g) || []).length, 0), 13000);
});

test('GitHub snapshots pin a commit and account for excluded, oversized, limited, and failed files', async () => {
  const originalFetch = globalThis.fetch;
  const previous = {
    maxFiles: process.env.GITHUB_MAX_FILES,
    maxBytes: process.env.GITHUB_MAX_FILE_BYTES,
  };
  process.env.GITHUB_MAX_FILES = '2';
  process.env.GITHUB_MAX_FILE_BYTES = '1000';
  const calls = [];
  try {
  const token = await api.user('retained-index@example.com');
  const project = await api.project(token, 'Retained index');
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(String(target));
    if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    calls.push({ url, authorization: new Headers(options.headers || {}).get('authorization') });
    if (url.hostname === 'api.github.com' && url.pathname === '/repos/acme/store') {
      return Response.json({ default_branch: 'main', description: 'Test repo', private: false });
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/commits/main')) {
      return Response.json({ sha: 'commit-123' });
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/git/trees/main')) {
      return Response.json({
        truncated: true,
        tree: [
          { type: 'blob', path: 'src/app.ts', size: 20 },
          { type: 'blob', path: 'README.md', size: 20 },
          { type: 'blob', path: 'package.json', size: 20 },
          { type: 'blob', path: 'src/large.ts', size: 1001 },
          { type: 'blob', path: 'node_modules/pkg/index.js', size: 200 },
        ],
      });
    }
    if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/src/app.ts')) return new Response('export const ok = true;');
    if (url.hostname === 'raw.githubusercontent.com' && url.pathname.endsWith('/README.md')) return new Response('unavailable', { status: 502 });
    throw new Error(`Unexpected mocked request: ${url.href}`);
  };
    const { fetchRepository } = await import('../apps/api/src/understanding/github.js');
    const progress = [];
    const snapshot = await fetchRepository({
      repositoryUrl: 'https://github.com/acme/store',
      token: 'test-token',
      onProgress: (item) => progress.push(item),
    });
    assert.equal(snapshot.repository.commit, 'commit-123');
    assert.equal(snapshot.files.length, 1);
    assert.deepEqual(snapshot.skipped.failed.map((item) => item.path), ['README.md']);
    assert.deepEqual(snapshot.skipped.tooLarge, ['src/large.ts']);
    assert.deepEqual(snapshot.skipped.overFileLimit, ['package.json']);
    assert.deepEqual(snapshot.skipped.excludedByPolicy, ['node_modules/pkg/index.js']);
    assert.equal(snapshot.skipped.truncatedTree, true);
    assert.ok(calls.filter((call) => call.url.hostname === 'raw.githubusercontent.com').every((call) => call.authorization === 'Bearer test-token'));
    assert.deepEqual(progress.at(-1), { fetched: 1, failed: 1, total: 2 });

    const { indexFiles, queueGithubIndex } = await import('../apps/api/src/knowledge/indexer.js');
    const { db } = await import('../apps/api/src/lib/db.js');
    indexFiles({
      projectId: project.id,
      repository: { fullName: 'acme/store', url: 'https://github.com/acme/store', branch: 'main', commit: 'old-commit' },
      source: 'github',
      files: [{ path: 'src/previous.ts', content: 'export const retained = "known good";' }],
    });
    const job = queueGithubIndex({
      projectId: project.id, repositoryUrl: 'https://github.com/acme/store', token: 'test-token', actor: token,
    });
    const finished = await api.waitForJob(token, project.id, job.id);
    assert.equal(finished.status, 'completed_with_warnings');
    assert.equal(finished.result.retainedPreviousIndex, true);
    assert.equal(db.getProfile(project.id).parts.code.repository.commit, 'old-commit');
    assert.ok(db.getChunks(project.id).some((chunk) => chunk.source === 'src/previous.ts'));
    assert.ok(!db.getChunks(project.id).some((chunk) => chunk.source === 'src/app.ts'));
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.maxFiles === undefined) delete process.env.GITHUB_MAX_FILES;
    else process.env.GITHUB_MAX_FILES = previous.maxFiles;
    if (previous.maxBytes === undefined) delete process.env.GITHUB_MAX_FILE_BYTES;
    else process.env.GITHUB_MAX_FILE_BYTES = previous.maxBytes;
  }
});

test('GitHub URLs are restricted to github.com and preserve nested branch names', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/acme/store/tree/feature/new-flow'), {
    owner: 'acme', repo: 'store', fullName: 'acme/store', branch: 'feature/new-flow',
  });
  assert.equal(parseRepoUrl('git@github.com:a/b.git').fullName, 'a/b');
  assert.throws(() => parseRepoUrl('https://github.com.attacker.invalid/acme/store'), /Expected a GitHub URL/);
});

test('redirect targets are revalidated before the next request', async () => {
  const originalFetch = globalThis.fetch;
  const previous = process.env.ALLOW_PRIVATE_NETWORK;
  let calls = 0;
  process.env.ALLOW_PRIVATE_NETWORK = 'false';
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  try {
    await assert.rejects(fetchWithTimeout('https://public.example/path'), /private network host/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_NETWORK;
    else process.env.ALLOW_PRIVATE_NETWORK = previous;
  }
});
