export type Source =
  | { kind: 'github'; url: string; fullName: string; name: string }
  | { kind: 'website'; url: string; name: string }

const GITHUB_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i
const GITHUB_SSH = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i
// GitHub usernames never contain dots, which keeps "example.com/page" out of this branch.
const OWNER_REPO = /^([A-Za-z0-9-]+)\/([\w.-]+)$/

const titleCase = (s: string) => s.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()

export function detectSource(input: string): Source | null {
  const s = input.trim()
  if (!s) return null
  const gh = s.match(GITHUB_URL) || s.match(GITHUB_SSH) || s.match(OWNER_REPO)
  if (gh) return { kind: 'github', url: s, fullName: `${gh[1]}/${gh[2]}`, name: titleCase(gh[2]) }
  if (/\s/.test(s) || !/\./.test(s)) return null
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    if (!url.hostname.includes('.')) return null
    return { kind: 'website', url: url.toString(), name: titleCase(url.hostname.replace(/^www\./, '').split('.')[0]) }
  } catch {
    return null
  }
}

const IGNORED = /(^|\/)(node_modules|dist|build|target|bin|obj|\.next|\.git|coverage|vendor|__pycache__|\.venv)\//
const INDEXABLE = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|go|java|kt|rb|php|cs|prisma|sql|graphql|gql|md|mdx|txt|rst|html?)$|(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|composer\.json|pom\.xml|build\.gradle(\.kts)?|Gemfile|[^/]+\.csproj|docker-compose\.ya?ml|Dockerfile|\.env\.example|vercel\.json|netlify\.toml|tsconfig\.json)$/i
const MAX_FILES = 2000
const MAX_BYTES = 500_000
// The API accepts request bodies up to 10 MB.
const MAX_TOTAL_BYTES = 8_000_000

export type FolderSelection = { folder: string; files: { path: string; content: string }[]; skipped: number }

// Filters in the browser so large folders (node_modules, builds, binaries) are never read or uploaded.
export async function readFolder(list: FileList): Promise<FolderSelection> {
  const all = [...list]
  const pathOf = (f: File) => (f as any).webkitRelativePath || f.name
  let total = 0
  const keep = all
    .filter((f) => { const p = pathOf(f); return f.size <= MAX_BYTES && !IGNORED.test(p) && !/\.min\.(js|css)$|lock(\.json)?$|\.lock$/i.test(p) && INDEXABLE.test(p) })
    .filter((f) => (total += f.size) <= MAX_TOTAL_BYTES)
    .slice(0, MAX_FILES)
  const files = await Promise.all(keep.map(async (f) => ({ path: pathOf(f), content: await f.text() })))
  const folder = all[0] ? pathOf(all[0]).split('/')[0] : ''
  return { folder, files, skipped: all.length - files.length }
}
