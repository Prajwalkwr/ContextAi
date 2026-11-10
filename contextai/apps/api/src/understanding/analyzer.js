// Static, code-aware analysis of a repository snapshot. Pattern-based (not a full AST):
// it recognises common conventions in JS/TS, Python, PHP/Laravel, Java/Kotlin/Spring,
// Ruby/Rails, C#/.NET, Go and static HTML, and records file:line for every finding.

export const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|go|java|kt|rb|php|cs|prisma|sql|graphql|gql)$/i;
export const DOC_EXT = /\.(md|mdx|txt|rst)$/i;
export const HTML_EXT = /\.html?$/i;
export const DATA_EXT = /\.(json|jsonc|ya?ml|toml|xml|css|scss|sass|less)$/i;
export const CONFIG_FILES = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|composer\.json|pom\.xml|build\.gradle(\.kts)?|Gemfile|[^/]+\.csproj|docker-compose\.ya?ml|Dockerfile|\.env\.example|vercel\.json|netlify\.toml|tsconfig\.json|\.gitignore|\.dockerignore)$/i;
export const IGNORED = /(^|\/)(node_modules|dist|build|target|bin|obj|\.next|\.git|coverage|vendor|__pycache__|\.venv)\//;

export function isIndexable(path) {
  const file = path.split('/').pop() || path;
  const isLockfile = /(?:^|[-_.])(?:lock|lockfile)(?:\.[^.]+)?$/i.test(file);
  return !IGNORED.test(path) && !/\.min\.(js|css)$/i.test(path) && !isLockfile &&
    (CODE_EXT.test(path) || DOC_EXT.test(path) || HTML_EXT.test(path) || DATA_EXT.test(path) || CONFIG_FILES.test(path));
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function extractPages(files) {
  return files.filter((f) => HTML_EXT.test(f.path)).map((f) => {
    const strip = (s) => htmlToText(s).slice(0, 150);
    const extractedForms = [...f.content.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => ({
      action: m[1].match(/action=["']([^"']*)["']/i)?.[1] || '',
      method: (m[1].match(/method=["']([^"']*)["']/i)?.[1] || 'GET').toUpperCase(),
      inputs: [...m[2].matchAll(/<(?:input|select|textarea)\b[^>]*name=["']([^"']+)["']/gi)].map((x) => x[1]),
    }));
    const metadata = f.page || {};
    const forms = metadata.forms || extractedForms;
    const headings = metadata.headings || [...f.content.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => strip(m[1])).filter(Boolean).slice(0, 40);
    const controls = metadata.controls || [];
    const title = metadata.title || strip(f.content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const description = metadata.description || f.content.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] || '';
    const featureLabels = [...new Set([...headings, ...controls.map((control) => control.label).filter(Boolean)])];
    return {
      file: f.path,
      url: f.url || null,
      title,
      description,
      purpose: description || headings[0] || htmlToText(f.text || f.content).slice(0, 240),
      headings,
      forms,
      controls,
      features: featureLabels.map((name) => ({ name, evidence: 'observed_on_page' })),
      links: metadata.links || [...new Set([...f.content.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]))],
      extractionStatus: metadata.status || 'extracted',
    };
  });
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function collect(files, patterns, build) {
  const out = [];
  for (const f of files) {
    for (const pattern of patterns) {
      for (const m of f.content.matchAll(pattern)) {
        const item = build(m, f);
        if (item) out.push({ ...item, file: f.path, line: lineOf(f.content, m.index) });
      }
    }
  }
  return out;
}

const DEPENDENCY_SIGNALS = {
  frontend: { react: 'React', next: 'Next.js', vue: 'Vue', '@angular/core': 'Angular', svelte: 'Svelte', vite: 'Vite', tailwindcss: 'Tailwind CSS' },
  backend: { express: 'Express', '@nestjs/core': 'NestJS', fastify: 'Fastify', koa: 'Koa', 'socket.io': 'Socket.IO' },
  data: { mongoose: 'MongoDB (Mongoose)', mongodb: 'MongoDB', pg: 'PostgreSQL', prisma: 'Prisma', '@prisma/client': 'Prisma', mysql2: 'MySQL', sequelize: 'Sequelize', typeorm: 'TypeORM', redis: 'Redis', ioredis: 'Redis' },
  auth: { jsonwebtoken: 'JWT', passport: 'Passport', bcrypt: 'bcrypt', bcryptjs: 'bcrypt', 'next-auth': 'NextAuth', '@clerk/clerk-sdk-node': 'Clerk', firebase: 'Firebase Auth' },
  services: { stripe: 'Stripe', cloudinary: 'Cloudinary', nodemailer: 'Nodemailer', openai: 'OpenAI', 'aws-sdk': 'AWS', '@aws-sdk/client-s3': 'AWS S3', axios: 'HTTP client (axios)' },
};

function detectStack(files) {
  const found = { frontend: new Set(), backend: new Set(), data: new Set(), auth: new Set(), services: new Set(), languages: new Set() };
  const evidence = [];
  for (const f of files.filter((f) => f.path.endsWith('package.json'))) {
    let pkg;
    try { pkg = JSON.parse(f.content); } catch { continue; }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [group, map] of Object.entries(DEPENDENCY_SIGNALS)) {
      for (const [dep, label] of Object.entries(map)) {
        if (deps[dep]) { found[group].add(label); evidence.push({ label, file: f.path, dependency: dep }); }
      }
    }
  }
  for (const f of files.filter((f) => CONFIG_FILES.test(f.path) && !f.path.endsWith('package.json'))) {
    for (const [group, label, re] of MANIFEST_SIGNALS) {
      if (re.test(f.content)) { found[group].add(label); evidence.push({ label, file: f.path }); }
    }
  }
  const ext = (re) => files.some((f) => re.test(f.path));
  for (const [re, lang] of [[/\.(ts|tsx)$/, 'TypeScript'], [/\.(js|jsx|mjs|cjs)$/, 'JavaScript'], [/\.py$/, 'Python'], [/\.go$/, 'Go'], [/\.java$/, 'Java'], [/\.kt$/, 'Kotlin'], [/\.php$/, 'PHP'], [/\.rb$/, 'Ruby'], [/\.cs$/, 'C#'], [/\.html?$/, 'HTML']]) {
    if (ext(re)) found.languages.add(lang);
  }
  const py = files.filter((f) => f.path.endsWith('.py')).map((f) => f.content).join('\n');
  if (/from fastapi|import fastapi/.test(py)) found.backend.add('FastAPI');
  if (/from django/.test(py)) found.backend.add('Django');
  if (/from flask/.test(py)) found.backend.add('Flask');
  if (!found.backend.size && !found.frontend.size && ext(/\.html?$/)) found.frontend.add('Static HTML site');
  return { ...Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v]])), evidence };
}

const MANIFEST_SIGNALS = [
  ['backend', 'Laravel', /laravel\/framework/], ['backend', 'Symfony', /symfony\/framework-bundle/],
  ['backend', 'Spring Boot', /spring-boot/], ['backend', 'Ktor', /io\.ktor/],
  ['backend', 'Ruby on Rails', /gem ['"]rails['"]/], ['backend', 'Sinatra', /gem ['"]sinatra['"]/],
  ['backend', 'ASP.NET Core', /Microsoft\.AspNetCore|Sdk="Microsoft\.NET\.Sdk\.Web"/],
  ['backend', 'Gin', /gin-gonic\/gin/], ['backend', 'Echo', /labstack\/echo/], ['backend', 'Fiber', /gofiber\/fiber/], ['backend', 'Chi', /go-chi\/chi/], ['backend', 'Gorilla Mux', /gorilla\/mux/],
  ['backend', 'Django', /^django\b/im], ['backend', 'FastAPI', /^fastapi\b/im], ['backend', 'Flask', /^flask\b/im],
  ['data', 'Eloquent ORM', /laravel\/framework/], ['data', 'JPA / Hibernate', /spring-boot-starter-data-jpa|hibernate/], ['data', 'ActiveRecord', /gem ['"]rails['"]|activerecord/],
  ['data', 'Entity Framework', /EntityFrameworkCore/], ['data', 'GORM', /gorm\.io\/gorm/], ['data', 'SQLAlchemy', /sqlalchemy/i],
  ['data', 'PostgreSQL', /postgresql|psycopg|lib\/pq|pgx|Npgsql|gem ['"]pg['"]/i], ['data', 'MySQL', /mysql/i], ['data', 'MongoDB', /mongo/i],
  ['auth', 'Spring Security', /spring-boot-starter-security/], ['auth', 'Laravel Sanctum/Passport', /laravel\/(sanctum|passport)/], ['auth', 'Devise', /gem ['"]devise['"]/],
  ['auth', 'JWT', /jwt/i], ['auth', 'ASP.NET Identity', /AspNetCore\.Identity/],
];

const dedupe = (items) => {
  const seen = new Set();
  return items.filter((r) => { const k = `${r.method} ${r.path} ${r.file}`; return !seen.has(k) && seen.add(k); });
};

const byExt = (files, re) => files.filter((f) => re.test(f.path));
const verb = (v) => ({ MAPGET: 'GET', MAPPOST: 'POST', MAPPUT: 'PUT', MAPDELETE: 'DELETE', MAPPATCH: 'PATCH', HANDLEFUNC: 'ANY', HANDLE: 'ANY', MATCH: 'ANY', ANY: 'ANY', REQUEST: 'ANY' }[v.toUpperCase()] || v.toUpperCase());

function extractRoutes(files) {
  const js = byExt(files, /\.(js|jsx|ts|tsx|mjs|cjs)$/);
  const routes = [
    ...collect(js, [
      /\b(?:app|router|server|\w+Router|fastify)\.(get|post|put|patch|delete)\s*\(\s*["'`](\/[^"'`]*)["'`]/g,
      /@(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/g,
    ], (m) => ({ method: m[1].toUpperCase(), path: m[2] || '/' })),
    // Python: FastAPI/Flask decorators, Django urlpatterns
    ...collect(byExt(files, /\.py$/), [/@\w+\.(get|post|put|patch|delete)\s*\(\s*["'](\/[^"']*)["']/g], (m) => ({ method: m[1].toUpperCase(), path: m[2] })),
    ...collect(byExt(files, /\.py$/), [/@\w+\.route\s*\(\s*["'](\/[^"']*)["'](?:[^)]*methods\s*=\s*\[\s*["'](\w+)["'])?/g], (m) => ({ method: (m[2] || 'GET').toUpperCase(), path: m[1] })),
    ...collect(byExt(files, /urls\.py$/), [/\b(?:re_)?path\s*\(\s*r?["']([^"']*)["']\s*,\s*([\w.]+)/g], (m) => ({ method: 'ANY', path: `/${m[1]}` })),
    // PHP: Laravel Route:: facade, Symfony attributes
    ...collect(byExt(files, /\.php$/), [
      /Route::(get|post|put|patch|delete|any|match|resource|apiResource)\s*\(\s*["']([^"']*)["']/gi,
      /#\[Route\(\s*["']([^"']+)["'](?:[^)]*methods:\s*\[\s*["'](\w+)["'])?/g,
    ], (m) => (m[0].startsWith('#[') ? { method: (m[2] || 'ANY').toUpperCase(), path: m[1] } : { method: /resource/i.test(m[1]) ? 'RESOURCE' : verb(m[1]), path: m[2].startsWith('/') ? m[2] : `/${m[2]}` })),
    // Java / Kotlin: Spring mappings
    ...collect(byExt(files, /\.(java|kt)$/), [
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["{]?\s*"([^"]*)"/g,
    ], (m) => ({ method: m[1] === 'Request' ? 'ANY' : m[1].toUpperCase(), path: m[2] || '/' })),
    // Ruby: Rails routes.rb and Sinatra
    ...collect(byExt(files, /\.rb$/), [
      /^\s*(get|post|put|patch|delete)\s+["']([^"']+)["']/gm,
      /^\s*resources?\s+:(\w+)/gm,
    ], (m) => (m[0].trim().startsWith('resource') ? { method: 'RESOURCE', path: `/${m[1]}` } : { method: m[1].toUpperCase(), path: m[2].startsWith('/') ? m[2] : `/${m[2]}` })),
    // C#: ASP.NET attributes and minimal APIs
    ...collect(byExt(files, /\.cs$/), [
      /\[Http(Get|Post|Put|Patch|Delete)\s*(?:\(\s*"([^"]*)"\s*\))?\]/g,
      /\[Route\(\s*"([^"]+)"\s*\)\]/g,
      /\.(MapGet|MapPost|MapPut|MapDelete|MapPatch)\s*\(\s*"([^"]+)"/g,
    ], (m) => (m[0].startsWith('[Route') ? { method: 'PREFIX', path: m[1] } : { method: verb(m[1]), path: m[2] || '' })),
    // Go: net/http, Gin, Echo, Fiber, Chi, Gorilla
    ...collect(byExt(files, /\.go$/), [
      /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\s*\(\s*"(\/[^"]*)"/g,
    ], (m) => ({ method: verb(m[1]), path: m[2] })),
  ];
  const mounts = collect(files, [/\b(?:app|router)\.use\s*\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*([A-Za-z_$][\w$.()'"/-]*)/g], (m) => ({ prefix: m[1], handler: m[2].slice(0, 60) }));
  // Frontend → backend connections: HTTP client calls that hit a path on the app's own API.
  const clientCalls = collect(files, [
    /\b(?:api|axios|http|client|request|instance)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]*\/[^"'`]*)["'`]/g,
    /\bfetch\s*\(\s*["'`]([^"'`]*\/api\/[^"'`]*)["'`](?:\s*,\s*\{[^}]*?method\s*:\s*["'`](\w+)["'`])?/g,
  ], (m) => (m[0].startsWith('fetch') ? { method: (m[2] || 'GET').toUpperCase(), path: m[1] } : { method: m[1].toUpperCase(), path: m[2] }));
  return { routes: dedupe(routes).slice(0, 400), mounts: mounts.slice(0, 100), clientCalls: dedupe(clientCalls).slice(0, 300) };
}

function extractModels(files) {
  const models = collect(files, [
    /mongoose\.model\s*(?:<[^>]*>)?\s*\(\s*["'`](\w+)["'`]/g,
    /\bmodel\s*\(\s*["'`](\w+)["'`]\s*,\s*\w+Schema/g,
    /^model\s+(\w+)\s*\{/gm,
    /@Entity\s*\(\s*(?:["'`](\w+)["'`])?\s*\)\s*(?:export\s+)?class\s+(\w+)/g,
    /sequelize\.define\s*\(\s*["'`](\w+)["'`]/g,
    /class\s+(\w+)\s*\(\s*(?:models\.Model|Base|db\.Model|SQLModel)\s*(?:,[^)]*)?\)/g,
    /class\s+(\w+)\s+extends\s+(?:Model|Authenticatable)\b/g,
    /class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/g,
    /@Entity[\s\S]{0,200}?(?:public\s+)?(?:data\s+)?class\s+(\w+)/g,
    /DbSet<(\w+)>/g,
    /type\s+(\w+)\s+struct\s*\{[^}]*gorm\.Model/g,
    /Schema::create\s*\(\s*["'](\w+)["']/g,
    /create_table\s+:(\w+)/g,
  ], (m) => ({ name: m[1] || m[2] }));
  const schemas = collect(files, [/const\s+(\w+)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(\s*\{([\s\S]*?)\n\}\s*[,)]/g], (m) => ({
    schema: m[1],
    fields: [...m[2].matchAll(/^\s{2}(\w+)\s*:/gm)].map((x) => x[1]).slice(0, 40),
  }));
  const unique = [...new Map(models.filter((m) => m.name).map((m) => [m.name, m])).values()];
  for (const model of unique) {
    const schema = schemas.find((s) => s.file === model.file);
    if (schema) model.fields = schema.fields;
  }
  return unique;
}

function detectAuth(files) {
  return collect(files, [
    /\b(jwt\.(?:sign|verify))\s*\(/g,
    /\b(bcrypt\.(?:hash|compare))\s*\(/g,
    /\b(passport\.(?:use|authenticate))\s*\(/g,
    /\b((?:require|verify|is|check)[A-Z]?\w*(?:Auth|Token|Admin|Role)\w*)\s*[=(:]/g,
    /(\[Authorize[^\]]*\])/g,
    /(@PreAuthorize|@Secured|@EnableWebSecurity|SecurityFilterChain)/g,
    /(->middleware\(\s*['"]auth[^'"]*['"]\)|Auth::(?:attempt|user|check))/g,
    /(before_action\s+:authenticate_\w+|has_secure_password)/g,
    /(@login_required|@permission_required|Depends\(\s*get_current_user\s*\))/g,
    /\b(jwt\.(?:Parse|ParseWithClaims)|bcrypt\.(?:GenerateFromPassword|CompareHashAndPassword))\s*\(/g,
    /\b(password_hash|password_verify|session_start)\s*\(/g,
  ], (m) => ({ symbol: m[1] }));
}

function extractEnvKeys(files) {
  const keys = new Set();
  for (const f of files) for (const m of f.content.matchAll(/(?:process\.env\.|os\.environ\[["']|os\.getenv\(["']|import\.meta\.env\.|env\(["']|getenv\(["']|ENV\[["']|os\.Getenv\("|Environment\.GetEnvironmentVariable\(")([A-Z][A-Z0-9_]+)/g)) keys.add(m[1]);
  return [...keys].sort().slice(0, 60);
}

function detectModules(files) {
  const counts = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const anchor = parts.findIndex((p) => ['src', 'app', 'server', 'backend', 'frontend', 'client', 'api'].includes(p));
    const name = anchor >= 0 && parts.length > anchor + 2 ? parts.slice(0, anchor + 2).join('/') : parts.length > 1 ? parts[0] : null;
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([path, fileCount]) => ({ path, fileCount }));
}

// Domain entities are derived from the project's own models and routes, never from a preset list.
function inferEntities(models, routes) {
  const counts = new Map();
  const add = (w, weight) => {
    const word = w.toLowerCase().replace(/s$/, '');
    if (word.length < 3 || ['api', 'v1', 'v2', 'auth', 'admin', 'id', 'new', 'all'].includes(word)) return;
    counts.set(word, (counts.get(word) || 0) + weight);
  };
  models.forEach((m) => add(m.name, 3));
  routes.forEach((r) => r.path.split('/').filter((s) => s && !s.startsWith(':') && !s.startsWith('{')).forEach((s) => add(s, 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, weight]) => ({ name, weight }));
}

export function analyzeProject(files) {
  const code = files.filter((f) => CODE_EXT.test(f.path) || CONFIG_FILES.test(f.path) || HTML_EXT.test(f.path));
  const { routes, mounts, clientCalls } = extractRoutes(code);
  const models = extractModels(code);
  return {
    stack: detectStack(files),
    routes,
    routeMounts: mounts,
    clientCalls,
    models,
    auth: detectAuth(code).slice(0, 60),
    envKeys: extractEnvKeys(code),
    modules: detectModules(files),
    entities: inferEntities(models, routes),
    pages: extractPages(files),
    docs: files.filter((f) => DOC_EXT.test(f.path)).map((f) => f.path),
    fileCount: files.length,
    analyzedAt: new Date().toISOString(),
  };
}

function splitWithLines(content, maxLines = 60) {
  const lines = content.split('\n');
  const parts = [];
  let text = '';
  let startLine = 1;
  let endLine = 0;
  const flush = () => {
    if (text) parts.push({ startLine, endLine, text });
    text = '';
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 6000) {
      flush();
      for (let offset = 0; offset < line.length; offset += 6000) {
        parts.push({ startLine: i + 1, endLine: i + 1, text: line.slice(offset, offset + 6000) });
      }
      startLine = i + 2;
      endLine = i + 1;
      continue;
    }
    const candidate = text ? `${text}\n${line}` : line;
    if (text && (endLine - startLine + 2 > maxLines || candidate.length > 6000)) flush();
    if (!text) startLine = i + 1;
    text = text ? `${text}\n${line}` : line;
    endLine = i + 1;
  }
  flush();
  return parts;
}

export function chunkProject(files, architecture) {
  const chunks = [];
  const a = architecture;
  chunks.push({
    source: 'architecture-summary',
    type: 'architecture',
    content: [
      `Stack: frontend ${a.stack.frontend.join(', ') || 'not detected'}; backend ${a.stack.backend.join(', ') || 'not detected'}; data ${a.stack.data.join(', ') || 'not detected'}; auth ${a.stack.auth.join(', ') || 'not detected'}; languages ${a.stack.languages.join(', ')}.`,
      `Models: ${a.models.map((m) => `${m.name} (${m.file})`).join(', ') || 'none detected'}.`,
      `Routes: ${a.routes.slice(0, 60).map((r) => `${r.method} ${r.path} (${r.file}:${r.line})`).join('; ') || 'none detected'}.`,
      `Modules: ${a.modules.map((m) => m.path).join(', ')}.`,
    ].join('\n'),
  });
  for (const f of files) {
    if (HTML_EXT.test(f.path)) {
      const page = a.pages.find((p) => p.file === f.path);
      const text = f.text || htmlToText(f.content);
      for (const part of splitWithLines(text, 30)) {
        if (part.text.trim()) chunks.push({ source: f.path, url: f.url || page?.url || null, type: 'page', title: page?.title, content: `${page?.title ? `${page.title}\n` : ''}${part.text}` });
      }
      continue;
    }
    const type = DOC_EXT.test(f.path) ? 'doc' : 'code';
    for (const part of splitWithLines(f.content, type === 'doc' ? 40 : 60)) {
      if (!part.text.trim()) continue;
      chunks.push({ source: f.path, type, startLine: part.startLine, endLine: part.endLine, content: part.text });
    }
  }
  return chunks;
}
