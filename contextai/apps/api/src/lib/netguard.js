// Blocks server-side requests to private/loopback networks (SSRF) unless explicitly allowed,
// e.g. for self-hosted deployments that call services on the same network.
const PRIVATE = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^\[?::1\]?$/, /^\[?f[cd]/i, /\.internal$/i];

export function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error(`Invalid URL: ${raw}`), { status: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Only http(s) URLs are allowed'), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error('URLs containing embedded credentials are not allowed'), { status: 400 });
  if (process.env.ALLOW_PRIVATE_NETWORK !== 'true' && PRIVATE.some((re) => re.test(url.hostname))) {
    throw Object.assign(new Error(`Requests to private network host "${url.hostname}" are blocked (set ALLOW_PRIVATE_NETWORK=true to allow)`), { status: 400 });
  }
  return url;
}

export async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    let target = assertPublicUrl(url);
    let headers = new Headers(opts.headers || {});
    let method = opts.method || 'GET';
    let body = opts.body;
    for (let redirects = 0; ; redirects++) {
      assertPublicUrl(target.href);
      const response = await fetch(target, { ...opts, method, body, headers, signal: controller.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirects >= 5) throw Object.assign(new Error('Too many redirects'), { status: 502 });
      await response.body?.cancel();
      const next = assertPublicUrl(new URL(location, target).href);
      if (response.status === 303 || ([301, 302].includes(response.status) && method.toUpperCase() === 'POST')) {
        method = 'GET';
        body = undefined;
        headers.delete('content-length');
        headers.delete('content-type');
      }
      if (next.origin !== target.origin) {
        headers = new Headers(headers);
        for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
      }
      target = next;
    }
  } finally {
    clearTimeout(timer);
  }
}
