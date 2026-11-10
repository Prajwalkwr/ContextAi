// Same-origin website discovery with static extraction and optional Playwright rendering.
import { createHash } from 'crypto';
import { assertPublicUrl, fetchWithTimeout } from '../lib/netguard.js';
import { htmlToText } from './analyzer.js';

const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES) || 200;
const MAX_SITEMAPS = Number(process.env.CRAWL_MAX_SITEMAPS) || 10;
const REQUEST_TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS) || 15000;
const MAX_RENDER_WAIT_MS = 15000;
const MIN_RENDER_WAIT_MS = 2000;
const RENDER_STABLE_MS = 1500;
const MAX_SCROLL_STEPS = 20;
const PAGE_CONCURRENCY = 4;
const ASSET = /\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js|ico|mp[34]|woff2?|ttf|eot)$/i;
const TRACKING = /^(utm_.+|fbclid|gclid|_ga)$/i;

function normalizedUrl(raw, base, origin) {
  let url;
  try { url = new URL(raw, base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) return null;
  url.hash = '';
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

function htmlLinks(html, base, origin) {
  const links = new Set();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const url = normalizedUrl(match[1] || match[2] || match[3] || '', base, origin);
    if (url && !ASSET.test(new URL(url).pathname)) links.add(url);
  }
  const canonical = html.match(/<link\b(?=[^>]*\brel\s*=\s*["'][^"']*\bcanonical\b[^"']*["'])[^>]*\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  return { links: [...links], canonical: canonical ? normalizedUrl(canonical, base, origin) : null };
}

function robotsPolicy(text) {
  const groups = [];
  let agents = [];
  let rules = [];
  const flush = () => { if (agents.length) groups.push({ agents, rules }); };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const split = line.indexOf(':');
    if (split < 0) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (key === 'user-agent') {
      if (rules.length) { flush(); agents = []; rules = []; }
      agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && agents.length && value) {
      rules.push({ allow: key === 'allow', path: value });
    }
  }
  flush();
  const selected = groups.filter((g) => g.agents.includes('*') || g.agents.some((a) => 'contextai-crawler'.startsWith(a)));
  const directives = selected.flatMap((g) => g.rules);
  const sitemaps = [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
  return {
    sitemaps,
    allows(path) {
      const matches = directives.filter((r) => {
        const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
        return new RegExp(`^${pattern}`).test(path);
      }).sort((a, b) => b.path.length - a.path.length);
      return !matches.length || matches[0].allow;
    },
  };
}

function pagePath(url) {
  const parsed = new URL(url);
  const pathname = parsed.pathname.endsWith('/') ? `${parsed.pathname}index` : parsed.pathname.replace(/\.html?$/i, '');
  const query = parsed.search ? `-${createHash('sha1').update(parsed.search).digest('hex').slice(0, 8)}` : '';
  return `site${pathname}${query}.html`;
}

function allowedBrowserRequest(request) {
  const method = request.method().toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  if (method !== 'POST') return false;
  const headers = request.headers();
  const pathname = new URL(request.url()).pathname;
  const readEndpoint = /(?:^|\/)(?:get|fetch|search|list|find|query|lookup)(?:[-_/]|$)/i.test(pathname);
  const jsonBody = /application\/json/i.test(headers['content-type'] || '');
  const bodySize = Buffer.byteLength(request.postData() || '', 'utf8');
  return readEndpoint && jsonBody && bodySize <= 16_384;
}

function isSpaShell(html, text) {
  const length = text.replace(/\s+/g, ' ').trim().length;
  const emptyMount = /<(?:div|main)[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/(?:div|main)>/i.test(html);
  const moduleShell = /<script[^>]+type=["']module["']/i.test(html) && length < 80;
  return length < 200 && (emptyMount || moduleShell);
}

async function loadPlaywright() {
  if (process.env.CRAWL_RENDER_JS === 'false') return { chromium: null, reason: 'JavaScript rendering disabled by configuration' };
  try {
    const { chromium } = await import('playwright');
    return { chromium, reason: null };
  } catch (error) {
    return { chromium: null, reason: `Playwright is unavailable: ${error.message}` };
  }
}

async function renderPage(browser, url, waitForShell = false) {
  const context = await browser.newContext({ userAgent: 'ContextAI-crawler' });
  const page = await context.newPage();
  const blockedRequests = [];
  const pageErrors = [];
  const pendingDataRequests = new Set();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType())) pendingDataRequests.add(request);
  });
  page.on('requestfinished', (request) => pendingDataRequests.delete(request));
  page.on('requestfailed', (request) => pendingDataRequests.delete(request));
  await page.route('**/*', async (route) => {
    const target = route.request().url();
    if (!/^https?:/i.test(target)) return route.abort();
    try { assertPublicUrl(target); } catch {
      blockedRequests.push(target);
      return route.abort();
    }
    if (!allowedBrowserRequest(route.request())) {
      blockedRequests.push(`${route.request().method()} ${target}`);
      return route.abort();
    }
    return route.continue();
  });
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS });
    if (!response || !response.ok()) throw new Error(`Browser navigation returned ${response?.status() ?? 'no response'}`);
    const readiness = waitForShell
      ? await waitForRenderedContent(page, pendingDataRequests)
      : { timedOut: false, reason: null };
    let scrollLimited = false;
    for (let i = 0; i < MAX_SCROLL_STEPS; i++) {
      const state = await page.evaluate(() => ({ y: window.scrollY, height: document.body?.scrollHeight || 0, viewport: window.innerHeight }));
      if (state.y + state.viewport >= state.height - 2) break;
      if (i === MAX_SCROLL_STEPS - 1) scrollLimited = true;
      await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.8, 400)));
      await page.waitForTimeout(150);
    }
    const data = await page.evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const text = document.body?.innerText?.replace(/\n{3,}/g, '\n\n').trim() || '';
      const links = [...document.querySelectorAll('a[href]')].filter(visible).map((el) => el.href);
      const controls = [...document.querySelectorAll('button, [role="button"], input, select, textarea, [role="tab"], summary')]
        .filter(visible).map((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 200),
          type: el.getAttribute('type') || '',
        })).filter((el) => el.label || el.type);
      return {
        html: document.documentElement.outerHTML,
        text,
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || '',
        headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).map((el) => el.innerText.trim()).filter(Boolean).slice(0, 40),
        links,
        controls: controls.slice(0, 100),
        forms: [...document.forms].filter(visible).map((form) => ({
          action: form.action,
          method: (form.method || 'get').toUpperCase(),
          inputs: [...form.querySelectorAll('input[name],select[name],textarea[name]')].map((el) => el.name).filter(Boolean),
        })).slice(0, 30),
        canonical: document.querySelector('link[rel~="canonical"]')?.href || null,
      };
    });
    return {
      ...data,
      finalUrl: page.url(),
      blockedRequests,
      pageErrors,
      scrollLimited,
      readinessTimedOut: readiness.timedOut,
      readinessReason: readiness.reason,
    };
  } finally {
    await context.close();
  }
}

async function waitForRenderedContent(page, pendingDataRequests) {
  const startedAt = Date.now();
  let previousLength = -1;
  let stableSince = startedAt;
  let lastState = { text: '', busy: false };
  while (Date.now() - startedAt < MAX_RENDER_WAIT_MS) {
    lastState = await page.evaluate(() => {
      const content = document.querySelector('main,[role="main"],#root,#app,#__next,#__nuxt') || document.body;
      return {
        text: content?.innerText?.replace(/\s+/g, ' ').trim() || '',
        busy: Boolean(document.querySelector('[aria-busy="true"]')),
      };
    });
    const { text, busy } = lastState;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length !== previousLength) {
      previousLength = normalized.length;
      stableSince = Date.now();
    }
    const onlyLoadingMessage = /^(loading|please wait|fetching(?:\s+.+)?|just a moment)[.!…\s]*$/i.test(normalized);
    const hasUnresolvedValue = /\b(?:NaN|undefined|null)\b/i.test(normalized);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= MIN_RENDER_WAIT_MS && pendingDataRequests.size === 0 && normalized.length >= 30 && !busy &&
      !onlyLoadingMessage && !hasUnresolvedValue &&
      Date.now() - stableSince >= RENDER_STABLE_MS) return { timedOut: false, reason: null };
    await page.waitForTimeout(250);
  }
  const normalized = lastState.text.replace(/\s+/g, ' ').trim();
  const unresolvedValue = /\b(?:NaN|undefined|null)\b/i.test(normalized);
  const onlyLoadingMessage = /^(loading|please wait|fetching(?:\s+.+)?|just a moment)[.!…\s]*$/i.test(normalized);
  const reason = pendingDataRequests.size
    ? 'data_requests_pending'
    : lastState.busy
      ? 'page_busy'
      : unresolvedValue
        ? 'unresolved_values'
        : normalized.length < 30 || onlyLoadingMessage
          ? 'insufficient_content'
          : null;
  return { timedOut: Boolean(reason), reason };
}

async function readText(url, origin, accept) {
  assertPublicUrl(url);
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'ContextAI-crawler', Accept: accept },
  }, REQUEST_TIMEOUT_MS);
  const finalUrl = normalizedUrl(response.url || url, url, origin);
  if (!finalUrl) throw Object.assign(new Error('Redirect left the connected website origin'), { status: 403 });
  return { response, finalUrl };
}

async function discoverSitemap(seeds, report, origin) {
  const queue = [...new Set(seeds)];
  const visited = new Set();
  const urls = [];
  while (queue.length && visited.size < MAX_SITEMAPS) {
    const sitemap = queue.shift();
    if (visited.has(sitemap)) continue;
    visited.add(sitemap);
    try {
      const { response, finalUrl } = await readText(sitemap, origin, 'application/xml,text/xml,text/plain,*/*');
      if (!response.ok) {
        if (response.status !== 404) report.discoveryErrors.push({ url: sitemap, status: response.status, stage: 'sitemap' });
        continue;
      }
      const xml = await response.text();
      const locations = [...xml.matchAll(/<loc\b[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi)]
        .map((m) => m[1].replace(/&amp;/gi, '&').trim());
      const childMaps = locations.map((loc) => normalizedUrl(loc, finalUrl, origin)).filter((loc) => loc && /\.xml(?:$|\?)/i.test(loc));
      queue.push(...childMaps.filter((loc) => !visited.has(loc)));
      urls.push(...locations.map((loc) => normalizedUrl(loc, finalUrl, origin)).filter((loc) => loc && !/\.xml(?:$|\?)/i.test(loc)));
    } catch (error) {
      report.discoveryErrors.push({ url: sitemap, error: error.message, stage: 'sitemap' });
    }
  }
  if (queue.length) report.discoveryErrors.push({ stage: 'sitemap', error: `Sitemap limit reached (${MAX_SITEMAPS})`, remaining: queue.length });
  return [...new Set(urls)];
}

export async function crawlWebsite({ url, maxPages = MAX_PAGES, onProgress = () => {} }) {
  const start = assertPublicUrl(url);
  const startUrl = normalizedUrl(start.href, start.href, start.origin);
  const limit = Math.max(1, Math.min(Number(maxPages) || MAX_PAGES, 500));
  const report = {
    discovered: [],
    pages: [],
    failed: [],
    blocked: [],
    authRequired: [],
    duplicates: [],
    javascriptRequired: [],
    discoveryErrors: [],
    browser: { enabled: false, available: false, warning: null },
  };
  let robots = { sitemaps: [], allows: () => true };
  try {
    const { response } = await readText(new URL('/robots.txt', start.origin).href, start.origin, 'text/plain,*/*');
    if (response.ok) robots = robotsPolicy(await response.text());
    else if (response.status >= 500) report.discoveryErrors.push({ url: `${start.origin}/robots.txt`, status: response.status, stage: 'robots' });
  } catch (error) {
    report.discoveryErrors.push({ url: `${start.origin}/robots.txt`, error: error.message, stage: 'robots' });
  }

  const sitemapSeeds = [
    ...robots.sitemaps.map((s) => normalizedUrl(s, start.href, start.origin)).filter(Boolean),
    new URL('/sitemap.xml', start.origin).href,
    new URL('/sitemap_index.xml', start.origin).href,
  ];
  const sitemapUrls = await discoverSitemap(sitemapSeeds, report, start.origin);
  const queue = [startUrl, ...sitemapUrls];
  const queued = new Set(queue);
  const visited = new Set();
  const discoveryOrder = new Map();
  const fileByPage = new Map();
  let discoverySequence = 0;
  const contentHashes = new Map();
  const files = [];
  let browser = null;
  const browserModule = await loadPlaywright();
  report.browser.enabled = process.env.CRAWL_RENDER_JS !== 'false';
  if (browserModule.chromium) {
    try {
      browser = await browserModule.chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
      });
      report.browser.available = true;
    } catch (error) {
      report.browser.warning = `Playwright could not launch Chromium: ${error.message}`;
    }
  } else if (report.browser.enabled) {
    report.browser.warning = browserModule.reason;
  }

  try {
    while (queue.length && visited.size < limit) {
      const batch = [];
      while (queue.length && batch.length < PAGE_CONCURRENCY && visited.size < limit) {
        const current = queue.shift();
        if (!current || visited.has(current)) continue;
        visited.add(current);
        discoveryOrder.set(current, discoverySequence++);
        batch.push(current);
      }
      await Promise.all(batch.map(async (current) => {
      report.discovered.push(current);
      const path = new URL(current).pathname;
      if (!robots.allows(path)) {
        report.blocked.push({ url: current, reason: 'Disallowed by robots.txt' });
        report.pages.push({ url: current, status: 'blocked', reason: 'Disallowed by robots.txt' });
        return;
      }
      try {
        const { response, finalUrl } = await readText(current, start.origin, 'text/html,application/xhtml+xml');
        if (response.status === 401 || response.status === 403) {
          report.authRequired.push({ url: current, status: response.status });
          report.pages.push({ url: current, status: 'authentication_required', httpStatus: response.status });
          return;
        }
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
          report.failed.push({ url: current, status: response.status, reason: response.ok ? `Unsupported content type: ${contentType || 'unknown'}` : response.statusText });
          report.pages.push({ url: current, status: 'failed', httpStatus: response.status });
          return;
        }
        const staticHtml = await response.text();
        const staticText = htmlToText(staticHtml);
        const staticShell = isSpaShell(staticHtml, staticText);
        const staticLinks = htmlLinks(staticHtml, finalUrl, start.origin);
        let extracted = {
          html: staticHtml, text: staticText,
          title: staticHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '',
          description: staticHtml.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] || '',
          headings: [...staticHtml.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => htmlToText(m[1])).filter(Boolean).slice(0, 40),
          links: staticLinks.links,
          controls: [],
          forms: [...staticHtml.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => ({
            action: m[1].match(/action=["']([^"']*)["']/i)?.[1] || '',
            method: (m[1].match(/method=["']([^"']*)["']/i)?.[1] || 'GET').toUpperCase(),
            inputs: [...m[2].matchAll(/<(?:input|select|textarea)\b[^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]),
          })),
          canonical: staticLinks.canonical,
          finalUrl,
          scrollLimited: false,
        };
        if (browser) {
          try {
            const rendered = await renderPage(browser, current, staticShell);
            const renderedUrl = normalizedUrl(rendered.finalUrl, current, start.origin);
            if (!renderedUrl) throw new Error('Browser navigation left the connected website origin');
            extracted = {
              ...rendered,
              finalUrl: renderedUrl,
              text: rendered.text || staticText,
              title: rendered.title || extracted.title,
              description: rendered.description || extracted.description,
              headings: rendered.headings.length ? rendered.headings : extracted.headings,
              forms: rendered.forms.map((form) => {
                const action = new URL(form.action, renderedUrl);
                return { ...form, action: action.origin === start.origin ? `${action.pathname}${action.search}` : action.href };
              }),
              links: [...new Set([...extracted.links, ...rendered.links.map((link) => normalizedUrl(link, renderedUrl, start.origin)).filter(Boolean)])],
              canonical: normalizedUrl(rendered.canonical || extracted.canonical || renderedUrl, renderedUrl, start.origin),
              scrollLimited: rendered.scrollLimited || rendered.readinessTimedOut,
              partialReasons: [
                ...(rendered.scrollLimited ? ['scroll_limit_reached'] : []),
                ...(rendered.readinessTimedOut ? [rendered.readinessReason || 'render_wait_timeout'] : []),
              ],
            };
            for (const target of rendered.blockedRequests) report.blocked.push({ url: target, reason: 'Private or unsupported browser request blocked' });
            for (const error of rendered.pageErrors) report.discoveryErrors.push({ url: current, error, stage: 'page_script' });
          } catch (error) {
            report.discoveryErrors.push({ url: current, error: error.message, stage: 'render' });
          }
        }
        const stillShell = staticShell && (
          !report.browser.available ||
          extracted.text.trim() === staticText.trim() ||
          extracted.text.trim().length < 30
        );
        if (stillShell) report.javascriptRequired.push(current);
        if (stillShell) {
          report.pages.push({ url: current, status: 'javascript_required', finalUrl: extracted.finalUrl, textLength: extracted.text.length, title: extracted.title });
          return;
        }
        const contentHash = createHash('sha256').update(extracted.text.replace(/\s+/g, ' ').trim()).digest('hex');
        let duplicateOf = contentHashes.get(contentHash);
        if (duplicateOf && discoveryOrder.get(current) > discoveryOrder.get(duplicateOf)) {
          report.duplicates.push({ url: current, duplicateOf, contentHash });
          report.pages.push({ url: current, status: 'duplicate', duplicateOf, finalUrl: extracted.finalUrl });
          return;
        }
        if (duplicateOf) {
          const previousFile = fileByPage.get(duplicateOf);
          const previousIndex = files.indexOf(previousFile);
          if (previousIndex >= 0) files.splice(previousIndex, 1);
          fileByPage.delete(duplicateOf);
          const previousPage = report.pages.find((page) => page.url === duplicateOf);
          if (previousPage) Object.assign(previousPage, { status: 'duplicate', duplicateOf: current });
          report.duplicates.push({ url: duplicateOf, duplicateOf: current, contentHash });
          contentHashes.set(contentHash, current);
        } else {
          contentHashes.set(contentHash, current);
        }
        const canonicalUrl = extracted.canonical || extracted.finalUrl;
        const file = {
          path: pagePath(canonicalUrl),
          content: extracted.html,
          text: extracted.text,
          url: canonicalUrl,
          page: {
            title: extracted.title,
            description: extracted.description,
            headings: extracted.headings,
            forms: extracted.forms,
            links: extracted.links,
            controls: extracted.controls || [],
            status: extracted.scrollLimited ? 'partial' : 'extracted',
            partialReasons: extracted.partialReasons || [],
          },
        };
        files.push(file);
        fileByPage.set(current, file);
        report.pages.push({
          url: current,
          status: extracted.scrollLimited ? 'partial' : 'extracted',
          finalUrl: extracted.finalUrl,
          canonicalUrl,
          ...(extracted.partialReasons?.length ? { partialReasons: extracted.partialReasons } : {}),
        });
        for (const next of extracted.links) {
          if (!queued.has(next) && !visited.has(next)) { queued.add(next); queue.push(next); }
        }
        onProgress({ fetched: report.pages.length, extracted: files.length, total: Math.min(limit, queue.length + visited.size) });
      } catch (error) {
        report.failed.push({ url: current, error: error.message, status: error.status || null });
        report.pages.push({ url: current, status: 'failed', reason: error.message });
      }
      }));
    }
  } finally {
    await browser?.close();
  }
  report.overPageLimit = queue.slice(0, 100);
  report.counts = {
    discovered: report.discovered.length + report.overPageLimit.length,
    fetched: report.pages.filter((p) => p.status !== 'failed' && p.status !== 'blocked' && p.status !== 'authentication_required').length,
    extracted: report.pages.filter((p) => ['extracted', 'partial', 'duplicate'].includes(p.status)).length,
    indexed: files.length,
    failed: report.failed.length,
    blocked: new Set([
      ...report.blocked.map((item) => item.url),
      ...report.pages.filter((page) => page.status === 'blocked').map((page) => page.url),
    ]).size,
    authRequired: report.authRequired.length,
    duplicates: report.duplicates.length,
    javascriptRequired: report.javascriptRequired.length,
    overLimit: report.overPageLimit.length,
  };
  const skipped = {
    notFetched: report.failed.map((item) => item.url),
    failed: report.failed,
    blocked: report.blocked,
    authRequired: report.authRequired,
    duplicates: report.duplicates,
    javascriptRequired: report.javascriptRequired,
    jsRendered: report.javascriptRequired,
    overPageLimit: report.overPageLimit,
    discoveryErrors: report.discoveryErrors,
    browser: report.browser,
    pages: report.pages,
    counts: report.counts,
  };
  if (!files.length) {
    const error = Object.assign(new Error(report.javascriptRequired.length
      ? 'No pages could be indexed because the site requires JavaScript rendering; verify the Playwright browser installation and retry.'
      : `No HTML pages could be fetched from ${start.href}`), { status: 502 });
    error.coverage = skipped;
    throw error;
  }
  return {
    files,
    site: { url: start.origin, pages: files.length, browserRendered: report.browser.available, discovered: report.counts.discovered },
    skipped,
    coverage: report,
  };
}
