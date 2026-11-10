import { tokenize } from '../knowledge/search.js';

export function classifyIntent(question) {
  const q = question.toLowerCase();
  const technical = /\b(how (does|do|is|are)|explain|architecture|where (is|are)|which file|source code|codebase|endpoint|route|middleware|controller|schema|model|implemented|internally|workflow|authenticat|authoriz)/.test(q);
  const dataWords = /\b(rate|count|total|average|sum|percent|how many|how much|revenue|profit|sales|highest|lowest|most|least|top|trend)\b/.test(q);
  if (technical && !dataWords) return 'technical';
  if (/\bwhy\b|\bcause|\breason|what went wrong|investigate/.test(q)) return 'investigation';
  if (/\bwhen did\b|\btrend|\bover time|\bincrease|\bdecrease|\bgrow|\bdrop|\bdeclin|\bchange/.test(q)) return 'trend';
  if (/\bwhich\b|\btop\b|\bhighest|\blowest|\bmost\b|\bleast\b|\bbest\b|\bworst\b|\bfewest|\brank/.test(q)) return 'ranking';
  if (/\bhow many\b|\bhow much\b|\btotal\b|\bcount\b|\baverage\b|\bsum\b|\brate\b|\breport\b|\bsummar/.test(q)) return 'metric';
  return technical ? 'technical' : 'general';
}

export function rankingDirection(question) {
  return /\b(least|lowest|fewest|worst|bottom|minimum|smallest|declining)\b/i.test(question) ? 'asc' : 'desc';
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const day = (d) => d.toISOString().slice(0, 10);

export function extractTimeRange(question, now = new Date()) {
  const q = question.toLowerCase();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000);
  const explicit = q.match(/(\d{4}-\d{2}-\d{2})\s*(?:to|and|-|until|through)\s*(\d{4}-\d{2}-\d{2})/);
  if (explicit) return { from: explicit[1], to: explicit[2], label: `${explicit[1]} to ${explicit[2]}` };
  if (/\btoday\b/.test(q)) return { from: day(now), to: day(now), label: 'today' };
  if (/\byesterday\b/.test(q)) return { from: day(daysAgo(1)), to: day(daysAgo(1)), label: 'yesterday' };
  const lastN = q.match(/\b(?:last|past)\s+(\d+)\s+days?\b/);
  if (lastN) return { from: day(daysAgo(Number(lastN[1]))), to: day(now), label: `last ${lastN[1]} days` };
  if (/\b(this|past|last)\s+week\b/.test(q)) return { from: day(daysAgo(7)), to: day(now), label: 'last 7 days' };
  if (/\bthis month\b/.test(q)) return { from: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: day(now), label: 'this month' };
  if (/\blast month\b/.test(q)) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { from: day(from), to: day(to), label: 'last month' };
  }
  if (/\bthis year\b/.test(q)) return { from: `${now.getUTCFullYear()}-01-01`, to: day(now), label: 'this year' };
  if (/\blast year\b/.test(q)) return { from: `${now.getUTCFullYear() - 1}-01-01`, to: `${now.getUTCFullYear() - 1}-12-31`, label: 'last year' };
  const monthYear = q.match(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{4})\\b`));
  if (monthYear) {
    const m = MONTHS.indexOf(monthYear[1]);
    const y = Number(monthYear[2]);
    return { from: day(new Date(Date.UTC(y, m, 1))), to: day(new Date(Date.UTC(y, m + 1, 0))), label: `${monthYear[1]} ${y}` };
  }
  const year = q.match(/\bin (\d{4})\b/);
  if (year) return { from: `${year[1]}-01-01`, to: `${year[1]}-12-31`, label: year[1] };
  return null;
}

export function questionTokens(question) {
  return new Set(tokenize(question));
}
