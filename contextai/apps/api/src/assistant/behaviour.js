// "What happens when…?" questions about how the assistant behaves under failure. Each answer
// describes what the code actually does (tools.js failure kinds, health.js, the http connector,
// personal-record scoping); the database case adds the connected project's live state.
import { checkProjectHealth, describeHealth } from './health.js';

const ASKS = /^\s*what\s+(happens|will happen|do you do|would happen|does (it|the (assistant|ai|bot|chatbot)) do)\s+(when|if)\b/i;

const SCENARIOS = [
  {
    id: 'database',
    test: (q) => /\b(database|db|mongo\w*|data ?store)\b/.test(q) && /\b(unavailable|down|offline|unreachable|disconnected|fails?|failure|crash\w*|not (connected|available|reachable))\b/.test(q),
    async answer({ project, name }) {
      const h = await checkProjectHealth(project).catch(() => null);
      const now = h && h.database.state !== 'unknown' ? ` Right now: ${describeHealth(h, 'database', name).replace(/\s*\(checked[^)]*\)\s*$/, '')}` : '';
      return `If the database can't be reached, I don't guess or reuse old numbers: health questions report the database as down (or degraded, when the backend has switched to fallback storage), and questions about live records get a plain reply that the data isn't reachable right now, instead of an invented figure.${now}`;
    },
  },
  {
    id: 'private',
    test: (q) => /\b(private|personal|someone else'?s|another (user|customer)'?s|other (users|customers)'?|inaccessible|restricted|confidential|unauthori[sz]ed)\b/.test(q) && /\b(data|records?|information|details|orders?|bookings?|payments?)\b/.test(q),
    async answer({ name }) {
      return `Requests for data the user isn't allowed to see are refused, not answered partially. Personal records are only read for a signed-in user whose identity ${name} has verified, and only that user's own records; anyone else's orders, bookings or details are never returned. Passwords, API keys, tokens and other secrets are never revealed, and every denied request is written to the audit log.`;
    },
  },
  {
    id: 'empty_ratings',
    test: (q) => /\b(ratings?|reviews?)\b/.test(q) && /\b(empty|no (ratings|reviews|data)|none|nothing|zero)\b/.test(q),
    async answer({ name }) {
      return `If nothing has been rated yet, I say so directly (for example, "None of the businesses on ${name} has been reviewed yet") rather than naming a "top" business or claiming I can't access the data. Businesses without reviews are always left out of rankings and averages and mentioned separately.`;
    },
  },
  {
    id: 'html_instead_of_data',
    test: (q) => /\bhtml\b/.test(q) || (/\b(crawler|scraper|endpoint|api)\b/.test(q) && /\b(web ?page|instead of (json|data|structured))\b/.test(q)),
    async answer() {
      return 'HTML is never treated as data. If a health endpoint returns a web page (common with single-page apps, which serve the same index.html for every path), that response is rejected and the next endpoint is tried; if none returns real JSON, the status is reported as unverified rather than healthy. If a connected data source returns a web page, the lookup fails with a clear message that the URL points at the website instead of its API, instead of being read as an empty list. When crawling the website itself, the page text is indexed as content, not as records.';
    },
  },
];

export function behaviourQuestion(question) {
  if (!ASKS.test(question)) return null;
  const q = question.toLowerCase().replace(/[’']/g, "'");
  return SCENARIOS.find((s) => s.test(q)) || null;
}
