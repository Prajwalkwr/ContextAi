// Fetches an immutable repository snapshot through the GitHub REST API.
import { fetchWithTimeout } from '../lib/netguard.js';
import { isIndexable } from './analyzer.js';

const MAX_FILES = Number(process.env.GITHUB_MAX_FILES) || 1000;
const MAX_FILE_BYTES = Number(process.env.GITHUB_MAX_FILE_BYTES) || 600_000;
const REQUEST_TIMEOUT_MS = Number(process.env.GITHUB_REQUEST_TIMEOUT_MS) || 15000;

export function parseRepoUrl(url) {
  const s = String(url).trim();
  const ssh = s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2], fullName: `${ssh[1]}/${ssh[2]}`, branch: null };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2], fullName: `${short[1]}/${short[2]}`, branch: null };
  let parsed;
  try { parsed = new URL(s); } catch { throw Object.assign(new Error('Expected a GitHub URL like https://github.com/owner/repo'), { status: 400 }); }
  if (!['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) {
    throw Object.assign(new Error('Expected a GitHub URL like https://github.com/owner/repo'), { status: 400 });
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, '');
  let branch = null;
  try { branch = parts[2] === 'tree' && parts.length > 3 ? decodeURIComponent(parts.slice(3).join('/')) : null; } catch {
    throw Object.assign(new Error('The branch in the GitHub URL is malformed'), { status: 400 });
  }
  if (!owner || !repo || (parts.length > 2 && parts[2] !== 'tree') || (parts[2] === 'tree' && !branch)) {
    throw Object.assign(new Error('Expected a GitHub URL like https://github.com/owner/repo'), { status: 400 });
  }
  return { owner, repo, fullName: `${owner}/${repo}`, branch };
}

async function gh(path, token) {
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'contextai',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }, REQUEST_TIMEOUT_MS);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw Object.assign(new Error(`GitHub ${response.status}: ${body.message || response.statusText}`), { status: response.status === 404 ? 404 : 502 });
  }
  return response.json();
}

export async function fetchRepository({ repositoryUrl, branch, token = process.env.GITHUB_TOKEN, onProgress = () => {} }) {
  const maxFiles = Math.max(1, Number(process.env.GITHUB_MAX_FILES) || MAX_FILES);
  const maxFileBytes = Math.max(1, Number(process.env.GITHUB_MAX_FILE_BYTES) || MAX_FILE_BYTES);
  const { owner, repo, fullName } = parseRepoUrl(repositoryUrl);
  const meta = await gh(`/repos/${owner}/${repo}`, token);
  const ref = branch || meta.default_branch;
  const [commit, tree] = await Promise.all([
    gh(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, token),
    gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token),
  ]);
  const blobs = tree.tree.filter((node) => node.type === 'blob');
  const indexable = blobs.filter((node) => isIndexable(node.path));
  const excludedByPolicy = blobs.filter((node) => !isIndexable(node.path)).map((node) => node.path);
  const tooLarge = indexable.filter((node) => Number(node.size) > maxFileBytes).map((node) => node.path);
  const candidates = indexable.filter((node) => Number(node.size) <= maxFileBytes);
  const selected = candidates.slice(0, maxFiles);
  const files = [];
  const failed = [];
  const binary = [];
  for (let i = 0; i < selected.length; i += 10) {
    const batch = await Promise.all(selected.slice(i, i + 10).map(async (node) => {
      const path = node.path.split('/').map(encodeURIComponent).join('/');
      const response = await fetchWithTimeout(
        `https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${path}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        REQUEST_TIMEOUT_MS,
      ).catch((error) => ({ ok: false, status: null, statusText: error.message }));
      if (!response.ok) {
        failed.push({ path: node.path, status: response.status, error: response.statusText || 'File fetch failed' });
        return null;
      }
      const content = await response.text();
      if (content.includes('\0')) {
        binary.push(node.path);
        return null;
      }
      if (Buffer.byteLength(content, 'utf8') > maxFileBytes) {
        failed.push({ path: node.path, status: null, error: 'Downloaded file exceeded the configured size limit' });
        return null;
      }
      return { path: node.path, content };
    }));
    files.push(...batch.filter(Boolean));
    onProgress({ fetched: files.length, failed: failed.length, total: selected.length });
  }

  const skipped = {
    discoveredFiles: blobs.length,
    eligibleFiles: indexable.length,
    fetchedFiles: files.length,
    failed,
    tooLarge,
    overFileLimit: candidates.slice(maxFiles).map((node) => node.path),
    excludedByPolicy,
    binary,
    truncatedTree: !!tree.truncated,
  };
  return {
    repository: {
      fullName,
      url: `https://github.com/${fullName}`,
      branch: ref,
      commit: commit.sha,
      description: meta.description,
      private: meta.private,
    },
    files,
    skipped,
  };
}
