// The central intelligence engine. Identical for every project: behaviour comes only from the
// project's indexed code, discovered data schema, business definitions and registered tools.
import { db } from '../lib/db.js';
import { searchKnowledge, tokenize } from '../knowledge/search.js';
import { executeQuery } from '../connectors/index.js';
import { executeTool } from '../connectors/restTools.js';
import { classifyIntent, rankingDirection, extractTimeRange, questionTokens } from './intent.js';
import { buildCatalog, matchDefinitions, rankCollections, describeFields, fieldTokens, overlap, nearOverlap, unmatchedTokens, entryKey } from './catalog.js';
import { parseFormula } from './formula.js';
import { composeAnswer, deterministicAnswer } from './compose.js';

export const SCHEMA_VERSION = '1.0';
const NEGATIVE = /cancel|fail|error|declin|reject|refund|timeout|unavailable|out_of_stock|inactive|overdue|lost|churn|abandon|dispute|chargeback/i;
const QUERY_FILLER = new Set('many have work works working explain tell show give me please answer question project website site app application system code source information'.split(' '));
// In "Does X support Stripe?" the subject is Stripe; "support" would match /support-tickets.
const SUPPORT_VERBS = new Set(tokenize('support supports offer offers accept accepts integrate integrates allow allows'));
function asksSupport(inv) {
  const name = inv.project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:does|do|can|will)\\s+(?:it|you|they|this|the\\s+(?:site|app|website|platform)|${name})\\s+(?:support|offer|accept|integrate|allow)s?\\b|\\b(?:is|are)\\b.*\\bsupported\\b`, 'i').test(inv.question);
}
function subjectTokens(inv) {
  const projectTokens = new Set(tokenize(inv.project.name));
  const support = asksSupport(inv);
  return [...inv.qTokens].filter((t) => !QUERY_FILLER.has(t) && !projectTokens.has(t) && !(support && SUPPORT_VERBS.has(t)));
}
const pct = (a, b) => (b ? Number(((a / b) * 100).toFixed(1)) : 0);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(n));
const quote = (v) => (v === null || v === undefined ? '(not recorded)' : `"${v}"`);

function relevantKnowledge(queryResults, qTokens) {
  const specificTokens = [...qTokens].filter((token) => !QUERY_FILLER.has(token));
  if (!specificTokens.length) return [];
  return queryResults.filter((item) => {
    const itemTokens = new Set(tokenize(`${item.source} ${item.snippet}`));
    return specificTokens.some((token) => itemTokens.has(token));
  });
}

function describeSpec(s) {
  const parts = [`${s.operation} ${s.collection}`];
  if (s.where.length) parts.push(`where ${s.where.map((w) => `${w.field} ${w.op}${['isnull', 'notnull'].includes(w.op) ? '' : ` ${JSON.stringify(w.value)}`}`).join(' and ')}`);
  if (s.groupBy.length) parts.push(`group by ${s.groupBy.join(', ')}`);
  if (s.metrics.length) parts.push(`metrics ${s.metrics.map((m) => (m.op === 'count' ? 'count' : `${m.op}(${m.field})`)).join(', ')}`);
  if (s.sort) parts.push(`sort ${s.sort.field} ${s.sort.dir === 1 ? 'asc' : 'desc'}`);
  if (s.operation !== 'count') parts.push(`limit ${s.limit}`);
  return parts.join(' ');
}

class Investigation {
  constructor({ project, question, actor, timeRange, intent, qTokens, direction }) {
    Object.assign(this, { project, question, actor, timeRange, intent, qTokens, direction });
    this.plan = [];
    this.evidence = [];
    this.findings = [];
    this.calculations = [];
    this.limitations = [];
    this.actions = [];
    this.sources = new Map();
    this.recordsAnalysed = 0;
    this.timeNotes = new Set();
    this.analysed = [];
    this.proposedActions = [];
  }

  step(action, detail) { this.plan.push({ step: this.plan.length + 1, action, detail }); }
  limit(message, severity = 'minor') { if (!this.limitations.some((l) => l.message === message)) this.limitations.push({ message, severity }); }
  action(text) { if (!this.actions.includes(text)) this.actions.push(text); }
  source(type, name) { this.sources.set(`${type}:${name}`, { type, name }); }
  finding(text, basis, evidenceIds = []) { this.findings.push({ text, basis, evidence: evidenceIds }); }
  calc(label, formula, inputs, result, evidenceId) { this.calculations.push({ label, formula, inputs, result, evidence: evidenceId }); }

  addEvidence(entry) {
    const id = `E${this.evidence.length + 1}`;
    this.evidence.push({ id, ...entry });
    return id;
  }

  timeWhere(entry, f) {
    if (!this.timeRange) return [];
    if (!f.time) {
      this.limit(`${entry.collection} has no recognised date field, so the period "${this.timeRange.label}" could not be applied; results cover all records.`, 'major');
      return [];
    }
    this.timeNotes.add(`${entry.collection}.${f.time}`);
    return [{ field: f.time, op: 'gte', value: this.timeRange.from }, { field: f.time, op: 'lte', value: `${this.timeRange.to}T23:59:59.999Z` }];
  }

  scopeWhere(collection) {
    const s = this.scope?.rows?.[collection];
    return s ? [{ field: s.field, op: 'eq', value: s.value }] : [];
  }

  async query(entry, f, spec, purpose) {
    const full = { collection: entry.collection, where: [], groupBy: [], metrics: [], ...spec };
    full.where = [...this.scopeWhere(entry.collection), ...this.timeWhere(entry, f), ...full.where];
    const result = await executeQuery({ projectId: this.project.id, integration: entry.integration, spec: full, actor: this.actor });
    const kind = entry.integration.type === 'dataset' ? (entry.integration.synthetic ? 'synthetic_dataset' : 'uploaded_dataset') : 'live_database';
    this.source(kind, `${entry.integration.name} / ${entry.collection}`);
    const id = this.addEvidence({ kind, source: `${entry.integration.name} / ${entry.collection}`, purpose, query: describeSpec(result.spec), recordCount: result.count, sample: result.rows.slice(0, 5) });
    return { ...result, evidenceId: id };
  }
}

async function analyseFormula(inv, entry, f, def, baseWhere) {
  let parsed;
  try { parsed = parseFormula(def.formula); } catch (e) { inv.limit(`Business definition "${def.term}" has an invalid formula: ${e.message}`, 'major'); return; }
  const known = new Set(entry.fields.map((x) => x.name));
  const missing = parsed.fields.filter((x) => !known.has(x));
  if (missing.length) {
    inv.limit(`"${def.term}" needs field(s) ${missing.join(', ')}, which ${entry.collection} does not have. The metric cannot be calculated without inventing data.`, 'major');
    inv.action(`Add ${missing.join(', ')} to ${entry.collection} or connect the source that stores it.`);
    return;
  }
  const fields = [...new Set([f.label, ...parsed.fields].filter(Boolean))];
  const r = await inv.query(entry, f, { operation: 'find', where: baseWhere, fields, limit: 1000 }, `Inputs for "${def.term}" = ${def.formula}`);
  const values = r.rows.map((row) => ({ label: row[f.label] ?? '(unnamed)', value: parsed.evaluate(row), row }));
  const valid = values.filter((v) => v.value !== null).sort((a, b) => (inv.direction === 'asc' ? a.value - b.value : b.value - a.value));
  const excluded = values.filter((v) => v.value === null);
  inv.recordsAnalysed = Math.max(inv.recordsAnalysed, valid.length);
  if (r.count > r.rows.length) inv.limit(`Only the first ${r.rows.length} of ${r.count} records were used for "${def.term}".`, 'major');
  if (excluded.length) {
    inv.limit(`${excluded.length} record(s) (${excluded.slice(0, 5).map((v) => v.label).join(', ')}) are missing ${parsed.fields.join('/')} values, so "${def.term}" was not calculated for them rather than estimated.`, 'major');
    inv.action(`Fill in ${parsed.fields.filter((x) => excluded.some((v) => typeof v.row[x] !== 'number')).join(', ')} for the excluded ${entry.collection} records.`);
  }
  if (!valid.length) { inv.limit(`No ${entry.collection} record has all inputs for "${def.term}".`, 'major'); return; }
  for (const v of valid.slice(0, 6)) {
    inv.calc(`${def.term}: ${v.label}`, def.formula, parsed.fields.map((x) => `${x}=${fmt(v.row[x])}`).join(', '), fmt(v.value), r.evidenceId);
  }
  const head = valid[0];
  const word = inv.direction === 'asc' ? 'Lowest' : 'Highest';
  inv.finding(`${word} ${def.term} in ${entry.collection}: ${head.label} at ${fmt(head.value)} (${def.formula}). Ranking: ${valid.slice(0, 6).map((v) => `${v.label} ${fmt(v.value)}`).join(', ')}.`, 'data', [r.evidenceId]);
  const total = valid.reduce((s, v) => s + v.value, 0);
  inv.calc(`Total ${def.term}`, `sum(${def.formula})`, `${valid.length} records`, fmt(total), r.evidenceId);
  inv.exact = r.count === r.rows.length;
}

async function analyseTarget(inv, entry, f, ctx) {
  const { target, total, dimension, baseWhere, dists } = ctx;
  const targetWhere = [...baseWhere, { field: target.field, op: 'eq', value: target.value }];
  const known = dists[target.field]?.rows.find((v) => v.value === target.value);
  const targetCount = known ? known.count : (await inv.query(entry, f, { operation: 'count', where: targetWhere }, `Count of ${target.field} = ${target.value}`)).count;
  const evid = dists[target.field]?.evidenceId;
  const rate = pct(targetCount, total);
  inv.calc(`${target.field} = "${target.value}" rate`, `${target.value} / total × 100`, `${fmt(targetCount)} / ${fmt(total)}`, `${rate}%`, evid);
  const distText = dists[target.field] ? ` Full ${target.field} breakdown: ${dists[target.field].rows.slice(0, 5).map((v) => `${v.value ?? 'not recorded'} ${v.count}`).join(', ')}.` : '';
  inv.finding(`${fmt(targetCount)} of ${fmt(total)} ${entry.collection} records (${rate}%) have ${target.field} = ${quote(target.value)}${target.via ? ` (${target.via})` : ''}.${distText}`, 'data', evid ? [evid] : []);
  if (!targetCount) return;

  const breakdown = async (dim, purpose) => {
    const r = await inv.query(entry, f, { operation: 'aggregate', groupBy: [dim, target.field], where: baseWhere, limit: 500 }, purpose);
    const groups = new Map();
    for (const row of r.rows) {
      const key = row.key[dim] ?? null;
      const g = groups.get(key) || { value: key, total: 0, hits: 0 };
      g.total += row.count;
      if (row.key[target.field] === target.value) g.hits += row.count;
      groups.set(key, g);
    }
    return { evidenceId: r.evidenceId, groups: [...groups.values()].map((g) => ({ ...g, rate: pct(g.hits, g.total) })) };
  };

  if (dimension) {
    const { groups, evidenceId } = await breakdown(dimension, `${target.value} rate by ${dimension}`);
    groups.sort((a, b) => (inv.direction === 'asc' ? a.rate - b.rate : b.rate - a.rate) || b.total - a.total);
    groups.slice(0, 8).forEach((g) => inv.calc(`${target.value} rate for ${dimension} ${quote(g.value)}`, `${target.value} / total × 100`, `${g.hits} / ${g.total}`, `${g.rate}%`, evidenceId));
    const top = groups[0];
    inv.finding(`${inv.direction === 'asc' ? 'Lowest' : 'Highest'} ${target.value} rate by ${dimension}: ${quote(top.value)} at ${top.rate}% (${top.hits} of ${top.total}). Others: ${groups.slice(1, 5).map((g) => `${g.value ?? 'not recorded'} ${g.rate}% (${g.hits}/${g.total})`).join(', ') || 'none'}.`, 'data', [evidenceId]);
    if (groups.some((g) => g.total < 5)) inv.limit(`Some ${dimension} groups have fewer than 5 records, so their rates are statistically unstable.`);
  }

  const negative = NEGATIVE.test(String(target.value));
  const explanatory = negative || inv.intent === 'investigation' ? f.explanatory.filter((x) => x !== target.field && x !== dimension).slice(0, 3) : [];
  for (const field of explanatory) {
    const r = await inv.query(entry, f, { operation: 'aggregate', groupBy: [field], where: targetWhere, limit: 20 }, `Recorded ${field} on ${target.value} records`);
    const recorded = r.rows.filter((x) => x.key[field] !== null && x.key[field] !== undefined && x.key[field] !== '');
    const recordedCount = recorded.reduce((s, x) => s + x.count, 0);
    const missing = targetCount - recordedCount;
    if (recorded.length) {
      inv.finding(`Among ${target.value} records, recorded ${field} values: ${recorded.slice(0, 4).map((x) => `${quote(x.key[field])} ${x.count} (${pct(x.count, targetCount)}%)`).join(', ')}.`, 'data', [r.evidenceId]);
      const lead = recorded[0];
      inv.action(`Prioritise ${field} = ${quote(lead.key[field])}, which accounts for ${pct(lead.count, targetCount)}% of ${target.value} ${entry.collection}.`);
    }
    if (missing > 0) inv.limit(`${missing} of ${targetCount} ${target.value} records have no ${field} recorded, so their cause is unknown.`, missing / targetCount > 0.5 ? 'major' : 'minor');
  }
  if (!explanatory.length && inv.intent === 'investigation' && !f.explanatory.includes(target.field)) {
    inv.limit(`${entry.collection} has no field that records a reason or error for ${target.value} records, so the cause cannot be established from the available data.`, 'major');
    inv.action(`Store a reason or error-code field on ${entry.collection} whenever ${target.field} becomes ${quote(target.value)}.`);
  }

  if (inv.intent === 'investigation' || inv.intent === 'general') {
    if (!dimension) {
      const candidates = Object.keys(dists).filter((d) => d !== target.field && !f.explanatory.includes(d) && dists[d].rows.length > 1 && dists[d].rows.length <= 15).slice(0, 3);
      for (const dim of candidates) {
        const { groups, evidenceId } = await breakdown(dim, `Is ${target.value} concentrated in a ${dim}?`);
        const hot = groups.filter((g) => g.total >= 3 && g.rate >= Math.max(1.5 * rate, rate + 10)).sort((a, b) => b.rate - a.rate)[0];
        if (hot) {
          inv.calc(`${target.value} rate for ${dim} ${quote(hot.value)}`, `${target.value} / total × 100`, `${hot.hits} / ${hot.total}`, `${hot.rate}%`, evidenceId);
          inv.finding(`${target.value} records are concentrated in ${dim} = ${quote(hot.value)}: ${hot.rate}% (${hot.hits}/${hot.total}) versus ${rate}% overall.`, 'data', [evidenceId]);
        }
      }
    }
    const numeric = f.numeric.slice(0, 4);
    if (numeric.length) {
      const r = await inv.query(entry, f, { operation: 'aggregate', groupBy: [target.field], where: baseWhere, metrics: numeric.map((n) => ({ op: 'avg', field: n })), limit: 50 }, `Compare numeric fields for ${target.value} vs other records`);
      const hit = r.rows.find((x) => x.key[target.field] === target.value);
      const rest = r.rows.filter((x) => x.key[target.field] !== target.value);
      for (const n of numeric) {
        const restCount = rest.reduce((s, x) => s + (x[`avg_${n}`] != null ? x.count : 0), 0);
        if (!hit || hit[`avg_${n}`] == null || !restCount) continue;
        const restAvg = rest.reduce((s, x) => s + (x[`avg_${n}`] ?? 0) * x.count, 0) / restCount;
        if (!restAvg || Math.abs(hit[`avg_${n}`] - restAvg) / Math.abs(restAvg) < 0.25) continue;
        const change = pct(hit[`avg_${n}`] - restAvg, restAvg);
        inv.calc(`Average ${n}: ${target.value} vs others`, 'avg(target) vs avg(rest)', `${fmt(hit[`avg_${n}`])} vs ${fmt(restAvg)}`, `${change > 0 ? '+' : ''}${change}%`, r.evidenceId);
        inv.finding(`Average ${n} is ${fmt(hit[`avg_${n}`])} on ${target.value} records versus ${fmt(restAvg)} on others (${change > 0 ? '+' : ''}${change}%). This is a correlation, not proof of cause.`, 'data', [r.evidenceId]);
      }
    }
  }
}

async function analyseTrend(inv, entry, f, baseWhere, metric, target) {
  const fields = [f.time, metric, target?.field].filter(Boolean);
  const r = await inv.query(entry, f, { operation: 'find', where: baseWhere, fields, sort: { field: f.time, dir: 1 }, limit: 1000 }, `Time series of ${metric || target?.field || 'record count'} by day`);
  if (r.count > r.rows.length) inv.limit(`Trend uses the earliest ${r.rows.length} of ${r.count} records.`, 'major');
  const buckets = new Map();
  for (const row of r.rows) {
    const d = String(row[f.time] ?? '').slice(0, 10);
    if (!d) continue;
    const b = buckets.get(d) || { day: d, n: 0, sum: 0, hits: 0 };
    b.n++;
    if (metric && typeof row[metric] === 'number') b.sum += row[metric];
    if (target && row[target.field] === target.value) b.hits++;
    buckets.set(d, b);
  }
  const series = [...buckets.values()].map((b) => ({ day: b.day, value: metric ? b.sum / b.n : target ? pct(b.hits, b.n) : b.n, n: b.n }));
  const what = metric ? `average ${metric}` : target ? `${target.value} rate (%)` : 'records per day';
  if (series.length < 2) { inv.limit(`Only ${series.length} day(s) of data in ${entry.collection}; a trend cannot be measured.`, 'major'); return; }
  let jump = null;
  for (let i = 1; i < series.length; i++) {
    const delta = series[i].value - series[i - 1].value;
    if (!jump || (inv.direction === 'asc' ? delta < jump.delta : delta > jump.delta)) jump = { from: series[i - 1], to: series[i], delta };
  }
  inv.recordsAnalysed = Math.max(inv.recordsAnalysed, r.rows.length);
  inv.calc(`Largest day-over-day change in ${what}`, 'value(day) − value(previous day)', `${jump.from.day}: ${fmt(jump.from.value)} → ${jump.to.day}: ${fmt(jump.to.value)}`, fmt(jump.delta), r.evidenceId);
  inv.finding(`Daily ${what} in ${entry.collection}: ${series.slice(-8).map((s) => `${s.day} ${fmt(s.value)}`).join(', ')}. The largest ${jump.delta >= 0 ? 'increase' : 'decrease'} was on ${jump.to.day} (${fmt(jump.from.value)} → ${fmt(jump.to.value)}).`, 'data', [r.evidenceId]);
}

async function analyseCollection(inv, entry, defs) {
  const f = describeFields(entry);
  const qt = inv.qTokens;
  inv.step('select_source', `${entry.integration.name} / ${entry.collection} (matched ${entry.matchedFields.length ? `fields ${entry.matchedFields.join(', ')}` : 'collection name or definition'})`);
  const baseWhere = defs.flatMap((d) => d.where || []);
  const total = (await inv.query(entry, f, { operation: 'count', where: baseWhere }, 'Records in scope')).count;
  inv.recordsAnalysed = Math.max(inv.recordsAnalysed, total);
  const state = { entry, f, baseWhere, total, target: null };
  inv.analysed.push(state);
  if (!total) {
    inv.limit(`No ${entry.collection} records match the question scope${inv.timeRange ? ` for ${inv.timeRange.label}` : ''}.`, 'major');
    return;
  }

  const filterDefs = defs.filter((d) => d.where?.length && !d.formula);
  for (const d of filterDefs) {
    const r = f.label ? await inv.query(entry, f, { operation: 'find', where: baseWhere, fields: [...new Set([f.label, ...d.where.map((w) => w.field)])], limit: 20 }, `Records matching "${d.term}"`) : null;
    inv.finding(`${fmt(total)} ${entry.collection} record(s) match "${d.term}" (${d.meaning})${r?.rows.length ? `: ${r.rows.slice(0, 10).map((x) => x[f.label]).join(', ')}` : ''}.`, 'data', r ? [r.evidenceId] : []);
    inv.exact = true;
  }

  const formulaDefs = defs.filter((d) => d.formula);
  for (const d of formulaDefs) await analyseFormula(inv, entry, f, d, baseWhere);
  if (formulaDefs.length) return;

  const matchedCat = f.categorical.filter((c) => overlap(fieldTokens(c), qt));
  const defFields = defs.map((d) => d.field).filter(Boolean);
  const profileFields = [...new Set([f.outcome, ...defFields, ...matchedCat, ...f.explanatory, ...f.categorical].filter((x) => x && f.categorical.includes(x)))].slice(0, 6);
  const dists = {};
  for (const field of profileFields) {
    const r = await inv.query(entry, f, { operation: 'aggregate', groupBy: [field], where: baseWhere, limit: 60 }, `Distribution of ${field}`);
    if (r.rows.length >= 60 || (r.rows.length > 20 && r.rows.length > total * 0.5)) continue;
    dists[field] = { evidenceId: r.evidenceId, rows: r.rows.map((x) => ({ value: x.key[field], count: x.count })) };
  }

  let target = null;
  const defTarget = defs.find((d) => d.field && d.value !== undefined && d.value !== null && d.value !== '');
  if (defTarget) target = { field: defTarget.field, value: defTarget.value, via: `business definition "${defTarget.term}"` };
  if (!target) {
    const candidates = [];
    for (const [field, d] of Object.entries(dists)) {
      for (const v of d.rows) if (v.value != null && overlap(new Set(tokenize(String(v.value))), qt)) candidates.push({ field, value: v.value, count: v.count, outcome: field === f.outcome });
    }
    candidates.sort((a, b) => b.outcome - a.outcome || b.count - a.count);
    if (candidates[0]) target = { field: candidates[0].field, value: candidates[0].value };
  }
  if (!target) {
    const flag = matchedCat.find((c) => entry.fields.find((x) => x.name === c)?.type === 'boolean' && dists[c]?.rows.some((v) => v.value === true));
    if (flag) target = { field: flag, value: true };
  }
  if (!target && f.outcome && dists[f.outcome] && (inv.intent === 'investigation' || NEGATIVE.test(inv.question))) {
    const neg = dists[f.outcome].rows.filter((v) => v.value != null && NEGATIVE.test(String(v.value))).sort((a, b) => b.count - a.count)[0];
    if (neg) target = { field: f.outcome, value: neg.value, via: `inferred from ${f.outcome} values; confirm with a business definition` };
  }

  state.target = target;
  const targetTokens = new Set(target ? tokenize(String(target.value)) : []);
  const dimension = defs.find((d) => d.field && (d.value === undefined || d.value === null || d.value === '') && d.field !== target?.field)?.field
    || matchedCat.find((c) => c !== target?.field && !f.explanatory.includes(c) && dists[c]?.rows.length > 1
      && overlap(new Set([...fieldTokens(c)].filter((t) => !targetTokens.has(t))), qt));
  const metric = defs.find((d) => d.metricField)?.metricField || f.numeric.find((n) => overlap(fieldTokens(n), qt));

  if (inv.intent === 'trend' && f.time) return analyseTrend(inv, entry, f, baseWhere, metric, target);
  if (inv.intent === 'trend' && !f.time) inv.limit(`${entry.collection} has no date field, so a trend cannot be measured.`, 'major');

  if (target) return analyseTarget(inv, entry, f, { target, total, dimension, baseWhere, dists });

  if (dimension) {
    const op = metric && /\b(average|avg|mean)\b/i.test(inv.question) ? 'avg' : 'sum';
    const label = metric ? `${op === 'avg' ? 'average' : 'total'} ${metric}` : 'record count';
    const r = await inv.query(entry, f, { operation: 'aggregate', groupBy: [dimension], where: baseWhere, metrics: metric ? [{ op, field: metric }] : [], limit: 100 }, `${metric ? `${op}(${metric})` : 'Records'} by ${dimension}`);
    const key = metric ? `${op}_${metric}` : 'count';
    const rows = [...r.rows].sort((a, b) => (inv.direction === 'asc' ? (a[key] ?? 0) - (b[key] ?? 0) : (b[key] ?? 0) - (a[key] ?? 0)));
    rows.slice(0, 6).forEach((x) => inv.calc(`${metric ? `${op}(${metric})` : 'count'} for ${quote(x.key[dimension])}`, metric ? `${op}(${metric})` : 'count(*)', `${x.count} records`, fmt(x[key] ?? 0), r.evidenceId));
    inv.finding(`By ${dimension}, ${inv.direction === 'asc' ? 'lowest' : 'highest'} ${label}: ${rows.slice(0, 5).map((x) => `${x.key[dimension] ?? 'not recorded'} ${fmt(x[key] ?? 0)}`).join(', ')}.`, 'data', [r.evidenceId]);
    inv.exact = r.count === r.rows.length;
    return;
  }

  if (metric) {
    if (inv.intent === 'ranking' && f.label) {
      const r = await inv.query(entry, f, { operation: 'find', where: baseWhere, fields: [f.label, metric], sort: { field: metric, dir: inv.direction === 'asc' ? 1 : -1 }, limit: 10 }, `${entry.collection} ranked by ${metric}`);
      inv.calc(`Ranking by ${metric}`, `sort ${metric} ${inv.direction === 'asc' ? 'ascending' : 'descending'}`, `${r.rows.length} of ${fmt(r.count)} records`, `${r.rows[0]?.[f.label]} (${fmt(r.rows[0]?.[metric])})`, r.evidenceId);
      inv.finding(`${inv.direction === 'asc' ? 'Lowest' : 'Highest'} ${metric} in ${entry.collection}: ${r.rows.slice(0, 6).map((x) => `${x[f.label]} ${fmt(x[metric])}`).join(', ')}.`, 'data', [r.evidenceId]);
      inv.exact = true;
      return;
    }
    const r = await inv.query(entry, f, { operation: 'aggregate', groupBy: [], where: baseWhere, metrics: ['sum', 'avg', 'min', 'max'].map((op) => ({ op, field: metric })), limit: 1 }, `Summary of ${metric}`);
    const s = r.rows[0] || {};
    inv.calc(`Summary of ${metric}`, 'sum / avg / min / max', `${fmt(s.count || 0)} records`, `sum ${fmt(s[`sum_${metric}`])}, avg ${fmt(s[`avg_${metric}`])}, min ${fmt(s[`min_${metric}`])}, max ${fmt(s[`max_${metric}`])}`, r.evidenceId);
    inv.finding(`${metric} across ${fmt(s.count || 0)} ${entry.collection} records: total ${fmt(s[`sum_${metric}`])}, average ${fmt(s[`avg_${metric}`])}, range ${fmt(s[`min_${metric}`])}–${fmt(s[`max_${metric}`])}.`, 'data', [r.evidenceId]);
    return;
  }

  if (filterDefs.length) return;
  const summaryField = f.outcome && dists[f.outcome] ? f.outcome : Object.keys(dists)[0];
  const d = summaryField && dists[summaryField];
  let listed = '';
  if (total <= 10 && f.label) {
    const r = await inv.query(entry, f, { operation: 'find', where: baseWhere, limit: 10 }, `All ${entry.collection} records in scope`);
    listed = ` Records: ${r.rows.map((x) => `${x[f.label]}${summaryField ? ` (${summaryField} ${x[summaryField]})` : ''}${f.time ? ` at ${String(x[f.time]).slice(0, 10)}` : ''}`).join('; ')}.`;
  }
  inv.finding(`${entry.collection} has ${fmt(total)} records in scope${d ? `; by ${summaryField}: ${d.rows.slice(0, 6).map((v) => `${v.value ?? 'not recorded'} ${v.count} (${pct(v.count, total)}%)`).join(', ')}` : ''}.${listed}`, 'data', d ? [d.evidenceId] : []);
  inv.exact = true;
  if (!listed) inv.limit(`The question did not map to a specific metric or field of ${entry.collection}, so only a summary is shown. Mention a field name or add a business definition for a precise answer.`);
}

const DURATION = /duration|minutes|mins|length/i;
const dayStart = (t) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

// Links two analysed collections: by a shared key (field values that overlap) and/or by time
// windows (events in one collection vs the target outcome rate in the other). Correlation only.
async function analyseRelation(inv, first, second) {
  let [a, b] = first.target ? [first, second] : [second, first];
  if (!a.target) {
    inv.limit(`${first.entry.collection} and ${second.entry.collection} were analysed separately: the question names no outcome to compare across them.`);
    return;
  }
  const aFields = [...new Set([...a.f.categorical, a.f.label, a.f.time, a.target.field].filter(Boolean))];
  const ar = await inv.query(a.entry, a.f, { operation: 'find', where: a.baseWhere, fields: aFields, limit: 1000 }, `${a.entry.collection} records for cross-collection analysis`);
  const br = await inv.query(b.entry, b.f, { operation: 'find', where: b.baseWhere, limit: 200 }, `${b.entry.collection} records for cross-collection analysis`);
  if (ar.count > ar.rows.length) inv.limit(`Cross-collection analysis used ${ar.rows.length} of ${ar.count} ${a.entry.collection} records.`, 'major');
  const hit = (r) => r[a.target.field] === a.target.value;
  const rateOf = (rows) => ({ n: rows.length, hits: rows.filter(hit).length, rate: pct(rows.filter(hit).length, rows.length) });
  const overall = rateOf(ar.rows);

  let key = null;
  const bStrings = b.entry.fields.filter((x) => x.type === 'string').map((x) => x.name);
  for (const af of aFields.filter((x) => x !== a.target.field && x !== a.f.time)) {
    const aVals = new Set(ar.rows.map((r) => r[af]).filter((v) => v != null));
    for (const bf of bStrings) {
      const bVals = [...new Set(br.rows.map((r) => r[bf]).filter((v) => v != null))];
      const shared = bVals.filter((v) => aVals.has(v)).length;
      if (shared && shared / bVals.length >= 0.5 && (!key || shared > key.shared)) key = { af, bf, shared };
    }
  }
  const timed = a.f.time && b.f.time;
  if (!key && !timed) {
    inv.limit(`No shared key or common time field links ${a.entry.collection} and ${b.entry.collection}; add a business definition or matching fields to relate them.`);
    return;
  }
  const durField = b.f.numeric.find((n) => DURATION.test(n));
  const label = (r) => r[b.f.label] ?? r[key?.bf] ?? r._id ?? '(record)';
  const rows = [];
  for (const rec of br.rows.slice(0, 50)) {
    let scope = key ? ar.rows.filter((r) => r[key.af] === rec[key.bf]) : ar.rows;
    let window = null;
    if (timed && rec[b.f.time]) {
      const startT = Date.parse(rec[b.f.time]);
      if (!Number.isNaN(startT)) {
        const endT = durField && typeof rec[durField] === 'number' ? startT + rec[durField] * 60000 : dayStart(startT) + 86400000 - 1;
        const from = durField ? startT : dayStart(startT);
        const inWin = (r) => { const t = Date.parse(r[a.f.time]); return t >= from && t <= endT; };
        window = { label: `${new Date(from).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(endT).toISOString().slice(0, 16).replace('T', ' ')}`, inside: rateOf(scope.filter(inWin)), outside: rateOf(scope.filter((r) => !inWin(r))) };
      }
    }
    rows.push({ rec, scope: rateOf(scope), window });
  }
  const score = (x) => (x.window?.inside.n ? x.window.inside.rate - x.window.outside.rate : x.scope.rate - overall.rate);
  rows.sort((x, y) => score(y) - score(x));
  inv.recordsAnalysed = Math.max(inv.recordsAnalysed, ar.rows.length);
  const parts = [];
  for (const x of rows.slice(0, 5)) {
    const name = `${b.entry.collection} ${quote(label(x.rec))}`;
    if (x.window?.inside.n) {
      inv.calc(`${a.target.value} rate during ${name}`, 'inside window vs outside', `${x.window.inside.hits}/${x.window.inside.n} vs ${x.window.outside.hits}/${x.window.outside.n}`, `${x.window.inside.rate}% vs ${x.window.outside.rate}%`, ar.evidenceId);
      parts.push(`during ${name}${key ? ` (${key.af} = ${quote(x.rec[key.bf])})` : ''}, ${x.window.label}: ${x.window.inside.rate}% (${x.window.inside.hits}/${x.window.inside.n}) vs ${x.window.outside.rate}% outside it`);
    } else if (key) {
      inv.calc(`${a.target.value} rate for ${key.af} = ${quote(x.rec[key.bf])}`, `${a.target.value} / total × 100`, `${x.scope.hits}/${x.scope.n}`, `${x.scope.rate}%`, ar.evidenceId);
      parts.push(`for ${name} (${key.af} = ${quote(x.rec[key.bf])}): ${x.scope.rate}% (${x.scope.hits}/${x.scope.n})`);
    }
  }
  if (!parts.length) {
    inv.limit(`No ${a.entry.collection} records fall inside any ${b.entry.collection} record's key or time window.`);
    return;
  }
  inv.step('relate', `Linked ${a.entry.collection} to ${b.entry.collection}${key ? ` by ${key.af} ↔ ${key.bf}` : ''}${timed ? ` and by time (${a.f.time} within ${b.f.time}${durField ? ` + ${durField}` : ' same day'})` : ''}`);
  inv.finding(`Cross-collection: ${a.target.value} rate in ${a.entry.collection} (overall ${overall.rate}%) ${parts.join('; ')}. This shows co-occurrence, not proven cause.`, 'data', [ar.evidenceId, br.evidenceId]);
}

const CODE_ASK = /\b(authenticat|authoriz|log ?in|sign[- ]?in|endpoint|route|api\b|handler|middleware|controller|schema|models?\b|architecture|code|implement|stack|files?\b|backend|frontend|database)/i;
// Commands and environment-variable setup in docs are not statements about the product.
const SHELL_LINE = /^(?:[$>]\s*)?(?:docker|npm|npx|yarn|pnpm|git|curl|cd|export|node)\s|\b[A-Z][A-Z0-9_]{3,}=\S|\b[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|URI|URL)\b/;
// Answers from page/document text: picks the sentences that best match the question.
function contentAnalysis(inv, knowledge) {
  const docs = knowledge.filter((k) => k.type === 'page' || k.type === 'doc');
  const picks = [];
  const topicTokens = subjectTokens(inv);
  const matchTokens = topicTokens.length ? new Set(topicTokens) : inv.qTokens;
  for (const d of docs.slice(0, 5)) {
    const sentences = d.snippet.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 400 && !SHELL_LINE.test(s));
    for (const s of sentences) {
      const hits = overlap(new Set(tokenize(s)), matchTokens);
      if (hits >= Math.min(2, matchTokens.size)) picks.push({ s, hits, d });
    }
  }
  picks.sort((x, y) => y.hits - x.hits);
  const used = new Set();
  const top = picks.filter((p) => !used.has(p.s) && used.add(p.s)).slice(0, topicTokens.length ? 3 : 1);
  if (!top.length) return;
  inv.finding(`From the project's own content: ${top.map((p) => `“${p.s}” (${p.d.source}${p.d.lines ? `:${p.d.lines}` : ''})`).join(' ')}`, 'content', [...new Set(top.map((p) => p.d.evidenceId))]);
}

const COMMAND = /^\s*(please\s+)?(cancel|refund|update|change|set|delete|remove|create|add|issue|send|approve|reject|mark|close|reopen|assign|book|reschedule|restock)\b/i;
export const isCommand = (question) => COMMAND.test(question);

// Never executes anything: proposes a registered write tool with parameters taken from the question.
function proposeActions(inv) {
  if (!COMMAND.test(inv.question)) return false;
  const tools = db.listTools(inv.project.id).filter((t) => (t.method || 'GET') !== 'GET');
  const scored = tools.map((t) => ({ t, s: overlap(new Set(tokenize(`${t.name} ${t.description}`)), inv.qTokens) })).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s);
  for (const { t } of scored.slice(0, 2)) {
    const params = {};
    for (const p of t.parameters || []) {
      const words = [...fieldTokens(p)].filter((w) => w !== 'id');
      for (const w of words.length ? words : [p.toLowerCase()]) {
        const m = inv.question.match(new RegExp(`\\b${w}\\w*\\s*(?:#|id|no\\.?|number|:|=)?\\s*["']?([A-Za-z0-9_-]*\\d[A-Za-z0-9_-]*|[A-Za-z0-9_-]{3,})["']?`, 'i'));
        if (m && !tokenize(m[1]).some((x) => words.includes(x))) { params[p] = /^\d+(\.\d+)?$/.test(m[1]) ? Number(m[1]) : m[1]; break; }
      }
    }
    const missing = (t.requiredParameters || []).filter((p) => params[p] === undefined);
    inv.proposedActions.push({ toolId: t.id, tool: t.name, method: t.method, description: t.description, params, missing, requiresApproval: true });
  }
  if (!inv.proposedActions.length) {
    inv.limit('This looks like a request to change data, but no registered write tool matches it. Register one under Integrate → tools; it will run only after approval.', 'major');
    return true;
  }
  const a = inv.proposedActions[0];
  inv.step('propose_action', `Proposed ${a.method} ${a.tool}; nothing is executed until a project owner approves it`);
  inv.finding(`Proposed action: ${a.tool} (${a.method}) with ${Object.keys(a.params).length ? Object.entries(a.params).map(([k, v]) => `${k} = ${quote(v)}`).join(', ') : 'no parameters'}. It has not been executed; submit it for approval to run it.${a.missing.length ? ` Missing: ${a.missing.join(', ')}.` : ''}`, 'action', []);
  return true;
}

// "Does UdyogConnect support Stripe?" / "How does it use React?": a dependency declared in the code
// is the most direct evidence. Matches the label's main word ("Socket.IO", "MongoDB (Mongoose)"),
// not descriptive words such as "client" in "HTTP client (axios)".
const indexedFrom = (profile) => [profile.repository?.fullName, profile.website?.url].filter(Boolean).join(' + ') || 'uploaded files';

function stackAnalysis(inv, profile) {
  const stack = profile?.architecture?.stack;
  if (!stack) return;
  const topic = new Set(subjectTokens(inv));
  const keyWords = (name) => [tokenize(name.replace(/\(.*\)/, ''))[0], ...tokenize(name.match(/\((.*)\)/)?.[1] || '')].filter(Boolean);
  const hits = Object.entries(stack).filter(([group]) => group !== 'evidence' && group !== 'languages')
    .flatMap(([group, names]) => names.filter((name) => keyWords(name).some((t) => topic.has(t))).map((name) => ({ group, name })));
  if (!hits.length) return;
  const where = (name) => (stack.evidence || []).filter((e) => e.label === name).map((e) => e.dependency ? `"${e.dependency}" in ${e.file}` : e.file);
  const id = inv.addEvidence({ kind: 'project_profile', source: indexedFrom(profile), purpose: 'Dependencies declared in the indexed repository', stack: hits });
  inv.stackHit = true;
  inv.finding(`${inv.project.name} uses ${hits.map(({ group, name }) => `${name} (${group}; declared as ${where(name).slice(0, 3).join(', ') || 'detected in the code'})`).join('; ')}.`, 'code', [id]);
}

function technicalAnalysis(inv, profile, knowledge) {
  if (!profile) {
    inv.limit('The project has not been indexed yet, so code and architecture questions cannot be answered. Connect a repository or upload source files.', 'major');
    return;
  }
  const a = profile.architecture;
  const qt = inv.qTokens;
  const id = inv.addEvidence({ kind: 'project_profile', source: indexedFrom(profile), purpose: 'Static analysis of the indexed repository', analyzedAt: a.analyzedAt, fileCount: a.fileCount });
  if (profile.repository) inv.source('project_profile', profile.repository.kind === 'website' ? profile.repository.fullName : `${profile.repository.fullName}@${profile.repository.commit?.slice(0, 7)}`);
  if (profile.website) inv.source('project_profile', profile.website.url);
  if (!profile.repository && !profile.website) inv.source('project_profile', 'uploaded source');
  const at = (x) => `${x.file}:${x.line}`;
  // "get approved" must not match every GET /get route.
  const topic = new Set(subjectTokens(inv).filter((t) => !/^(get|post|put|patch|delete|api|work|use|make)$/.test(t)));
  const hits = (tokens) => nearOverlap(tokens, topic);
  // A word that matches one route ("register") says more than one that matches many ("business").
  const byRelevance = (list, tokensOf) => {
    const rows = list.map((r) => ({ r, words: [...topic].filter((q) => nearOverlap(tokensOf(r), new Set([q]))) }));
    const freq = new Map();
    for (const x of rows) for (const w of x.words) freq.set(w, (freq.get(w) || 0) + 1);
    return rows.map((x) => ({ r: x.r, n: x.words.reduce((s, w) => s + 1 / freq.get(w), 0) })).filter((x) => x.n).sort((x, y) => y.n - x.n).map((x) => x.r);
  };
  const routes = byRelevance(a.routes, (r) => new Set([...fieldTokens(r.path), ...fieldTokens(r.file)]));
  const calls = byRelevance(a.clientCalls || [], (r) => fieldTokens(r.path));
  const models = a.models.filter((m) => hits(fieldTokens(m.name)) || hits(fieldTokens(m.file)));
  const wantsAuth = /auth|login|sign ?in|token|password|permission|role|session/i.test(inv.question);
  const wantsOverview = /architecture|stack|overview|structure|built with|framework|modules?/i.test(inv.question);

  if (!inv.stackHit && asksSupport(inv) && topic.size) {
    const mentions = [];
    for (const k of knowledge.filter((k) => k.type !== 'architecture')) {
      const line = k.snippet.split('\n').map((l) => l.trim()).find((l) => l.length < 240 && tokenize(l).some((t) => topic.has(t)));
      if (line && !mentions.some((m) => m.line === line)) mentions.push({ line, k });
      if (mentions.length === 3) break;
    }
    if (mentions.length) inv.finding(`The code mentions it: ${mentions.map(({ line, k }) => `“${line}” (${k.source}${k.lines ? `:${k.lines}` : ''})`).join('; ')}.`, 'code', mentions.map(({ k }) => k.evidenceId));
  }
  if (wantsOverview) {
    const s = a.stack;
    inv.finding(`Stack detected from dependencies: frontend ${s.frontend.join(', ') || 'none detected'}; backend ${s.backend.join(', ') || 'none detected'}; data ${s.data.join(', ') || 'none detected'}; auth ${s.auth.join(', ') || 'none detected'}. Main modules: ${a.modules.slice(0, 8).map((m) => m.path).join(', ')}. ${a.routes.length} routes and ${a.models.length} models found.`, 'code', [id]);
  }
  const pages = a.pages || [];
  if (pages.length && (/\b(page|pages|form|forms|contact|site|website|section|navigation|menu|link)/i.test(inv.question) || (!a.routes.length && !a.models.length))) {
    const relevant = pages.filter((p) => overlap(new Set(tokenize(`${p.file} ${p.title} ${p.headings.join(' ')}`)), qt)).slice(0, 8);
    const list = (relevant.length ? relevant : pages.slice(0, 8)).map((p) => `${p.title || p.file} (${p.file})${p.headings.length ? ` — sections: ${p.headings.slice(0, 5).join(', ')}` : ''}`);
    inv.finding(`${pages.length} page(s) indexed: ${list.join('; ')}.`, 'code', [id]);
    const forms = pages.flatMap((p) => p.forms.map((f) => ({ ...f, file: p.file })));
    if (forms.length && /form|contact|submit|sign|subscribe|book|order|input/i.test(inv.question)) {
      inv.finding(`Forms: ${forms.slice(0, 8).map((f) => `${f.method} ${f.action || '(same page)'} with fields ${f.inputs.join(', ') || 'none named'} (${f.file})`).join('; ')}.`, 'code', [id]);
    }
  }
  if (routes.length) inv.finding(`Backend routes: ${routes.slice(0, 12).map((r) => `${r.method} ${r.path} (${at(r)})`).join('; ')}.`, 'code', [id]);
  if (calls.length) inv.finding(`Frontend calls to these endpoints: ${calls.slice(0, 8).map((r) => `${r.method} ${r.path} (${at(r)})`).join('; ')}.`, 'code', [id]);
  if (profile.skipped?.jsRendered?.length) inv.limit(`${profile.skipped.jsRendered.length} page(s) are rendered by JavaScript, so the crawler only saw an empty shell. Connect the repository to understand this site.`, 'major');
  const skipped = [...(profile.skipped?.tooLarge || []), ...(profile.skipped?.overFileLimit || [])];
  if (skipped.length) inv.limit(`${skipped.length} file(s) were not indexed because of size or count limits (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', …' : ''}); answers may miss code there.`);
  if (models.length) inv.finding(`Related data models: ${models.slice(0, 8).map((m) => `${m.name} (${at(m)})${m.fields?.length ? ` fields: ${m.fields.slice(0, 12).join(', ')}` : ''}`).join('; ')}.`, 'code', [id]);
  if (wantsAuth) {
    if (a.auth.length || a.stack.auth.length) {
      inv.finding(`Authentication: libraries ${a.stack.auth.join(', ') || 'none in package.json'}; implementation points ${a.auth.slice(0, 10).map((x) => `${x.symbol} (${at(x)})`).join('; ') || 'not found'}.`, 'code', [id]);
    } else inv.limit('No authentication implementation was detected in the indexed files.', 'major');
  }
  const refs = knowledge.filter((k) => k.type !== 'architecture').slice(0, 6);
  if (refs.length) inv.finding(`Most relevant source references: ${refs.map((k) => `${k.source}${k.lines ? `:${k.lines}` : ''}`).join(', ')}.`, 'code', refs.map((k) => k.evidenceId));
  if (!routes.length && !calls.length && !models.length && !refs.length) inv.limit('No indexed code matched the question terms.', 'major');
}

async function runMatchingTools(inv) {
  const tools = db.listTools(inv.project.id).filter((t) => (t.method || 'GET') === 'GET' && !(t.parameters || []).length);
  for (const tool of tools) {
    if (overlap(new Set(tokenize(`${tool.name} ${tool.description}`)), inv.qTokens) < 2) continue;
    try {
      const res = await executeTool({ projectId: inv.project.id, tool, actor: inv.actor });
      const id = inv.addEvidence({ kind: 'registered_api', source: tool.name, purpose: tool.description, httpStatus: res.status, sample: (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)).slice(0, 2000) });
      inv.source('registered_api', tool.name);
      inv.step('tool_call', `Called registered tool ${tool.name} (HTTP ${res.status})`);
      inv.finding(`Registered API "${tool.name}" responded with HTTP ${res.status}; the response is attached as evidence ${id}.`, 'api', [id]);
    } catch (e) {
      inv.limit(`Registered tool "${tool.name}" failed: ${e.message}`);
    }
  }
}

function assessConfidence(inv) {
  const levels = ['low', 'medium', 'high'];
  const major = inv.limitations.filter((l) => l.severity === 'major').length;
  const dataFindings = inv.findings.filter((f) => f.basis === 'data').length;
  const codeFindings = inv.findings.filter((f) => f.basis === 'code').length;
  if (dataFindings && inv.exact && !major) {
    return { confidence: 'high', basis: `Exact computation over all ${inv.recordsAnalysed} records in scope; no estimation or sampling.` };
  }
  if (dataFindings) {
    const n = inv.recordsAnalysed;
    let level = n >= 100 ? 2 : n >= 20 ? 1 : 0;
    level = Math.max(0, level - Math.min(major, 1));
    return { confidence: levels[level], basis: `${dataFindings} data finding(s) from ${n} records; ${major} major limitation(s). High requires ≥100 records, medium ≥20.` };
  }
  if (inv.findings.some((f) => f.basis === 'action')) {
    const a = inv.proposedActions[0];
    return { confidence: a.missing.length ? 'low' : 'medium', basis: `Action proposal matched to registered tool "${a.tool}"; parameters were extracted from the question and must be confirmed by a person before execution.` };
  }
  const contentFindings = inv.findings.filter((f) => f.basis === 'content').length;
  if (contentFindings && !codeFindings) {
    return { confidence: 'medium', basis: 'Quoted directly from the project’s indexed pages or documents; content may be outdated if the site changed since indexing.' };
  }
  if (codeFindings) {
    const refs = inv.evidence.filter((e) => ['indexed_code', 'indexed_doc', 'indexed_page'].includes(e.kind)).length;
    const level = refs >= 3 && !major ? 1 : 0;
    return { confidence: levels[level], basis: `${codeFindings} finding(s) from static code analysis with ${refs} source reference(s). Static analysis is pattern-based, so confidence is capped at medium.` };
  }
  return { confidence: 'low', basis: 'No finding could be supported by project evidence.' };
}

async function probeValues(inv, entries) {
  const hits = new Map();
  const open = unmatchedTokens(entries, inv.qTokens);
  if (!open.size) return hits;
  for (const entry of entries.slice(0, 8)) {
    const strings = describeFields(entry).categorical.filter((c) => entry.fields.find((x) => x.name === c)?.type === 'string').slice(0, 5);
    for (const field of strings) {
      try {
        const r = await executeQuery({ projectId: inv.project.id, integration: entry.integration, spec: { collection: entry.collection, operation: 'aggregate', groupBy: [field], where: inv.scopeWhere(entry.collection), metrics: [], limit: 60 }, actor: inv.actor });
        if (r.rows.length >= 60) continue;
        const count = r.rows.filter((row) => row.key[field] != null && overlap(new Set(tokenize(String(row.key[field]))), open)).length;
        if (!count) continue;
        const h = hits.get(entryKey(entry)) || { count: 0, fields: [] };
        h.count += count;
        h.fields.push(field);
        hits.set(entryKey(entry), h);
      } catch { /* an unavailable field only loses ranking signal */ }
    }
  }
  if (hits.size) inv.step('probe_values', `Question terms ${[...open].join(', ')} found as stored values in ${[...hits.keys()].map((k) => k.split(':')[1]).join(', ')}`);
  return hits;
}

// Options used by the assistant orchestrator (defaults keep the standalone engine unchanged):
// knowledge  — pre-retrieved, relevance-gated references instead of a raw keyword search
// scope      — { rows: { collection: { field, value } }, only } restricts data to one user's rows
// compose    — false returns the deterministic answer without an LLM call
// record     — false skips persisting the investigation (the caller records the final answer)
// codeFallback — false never answers with static code analysis when nothing else matched
// data       — false skips connected data sources (documentation/how-to questions)
export async function investigate({ project, question, actor, timeRange: explicitRange, knowledge: provided, scope = null, compose = true, record = true, codeFallback = true, data = true }) {
  const started = Date.now();
  const intent = classifyIntent(question);
  const qTokens = questionTokens(question);
  const timeRange = explicitRange ? { ...explicitRange, label: `${explicitRange.from} to ${explicitRange.to}` } : extractTimeRange(question);
  const inv = new Investigation({ project, question, actor, timeRange, intent, qTokens, direction: rankingDirection(question) });
  Object.assign(inv, { scope, options: { compose, record } });
  inv.step('receive', `Request for project ${project.name} (${project.id})`);
  inv.step('intent', `Intent classified as "${intent}"${timeRange ? `; period ${timeRange.label}` : ''}`);

  if (qTokens.size < 1) {
    return finish(inv, started, { status: 'clarification_needed', answer: 'The question is too short to interpret. Please describe what you want to know, e.g. a metric, a record type or a feature.' });
  }

  const definitions = db.listDefinitions(project.id);
  const defs = matchDefinitions(definitions, qTokens);
  for (const d of defs) {
    inv.source('business_definition', d.term);
    inv.addEvidence({ kind: 'business_definition', source: d.term, purpose: 'Developer-confirmed meaning', definition: d });
  }
  inv.step('load_context', `${defs.length} business definition(s) matched`);

  const profile = db.getProfile(project.id);
  const knowledgeResults = provided ?? relevantKnowledge(searchKnowledge({ projectId: project.id, query: question, limit: intent === 'technical' ? 8 : 4 }), qTokens);
  const knowledge = knowledgeResults.map((k) => {
    const kind = k.type === 'doc' ? 'indexed_doc' : k.type === 'page' ? 'indexed_page' : 'indexed_code';
    inv.source(kind, `${k.source}${k.lines ? `:${k.lines}` : ''}`);
    return { ...k, evidenceId: inv.addEvidence({
      kind, source: k.source, url: k.url, sourceVersion: k.sourceVersion,
      lines: k.lines, score: k.score, snippet: k.snippet,
    }) };
  });
  inv.step('knowledge_search', `${knowledge.length} reference(s) from indexed code and documentation`);

  const integrations = db.listIntegrations(project.id);
  const isCommand = proposeActions(inv);
  if (!isCommand && data && (intent !== 'technical' || defs.some((d) => d.collection) || scope?.only)) {
    const catalog = await buildCatalog(integrations);
    const { failures } = catalog;
    const entries = scope?.only ? catalog.entries.filter((e) => scope.rows[e.collection]) : catalog.entries;
    if (scope?.only) inv.step('user_scope', `Restricted to the signed-in user's rows in ${Object.entries(scope.rows).map(([c, s]) => `${c}.${s.field}`).join(', ')}`);
    failures.forEach((x) => inv.limit(`Integration "${x.integration}" is unavailable (${x.error}); its data was not checked.`, 'major'));
    inv.step('discover_schema', `${entries.length} allowlisted collection(s) across ${integrations.length} integration(s)`);
    const valueHits = await probeValues(inv, entries);
    const ranked = rankCollections(entries, qTokens, defs, valueHits);
    if (!integrations.length) {
      inv.limit('No data integration is connected, so live project data could not be checked.', intent === 'technical' || knowledge.length ? 'minor' : 'major');
      if (!knowledge.length) inv.action('Connect a database, API or dataset in the Data tab, or index the site or repository.');
    } else if (!ranked.length) {
      inv.limit(`No connected collection or field matches the question. Available: ${entries.map((e) => `${e.collection} (${e.fields.slice(0, 6).map((x) => x.name).join(', ')})`).join('; ') || 'none'}.`, knowledge.length ? 'minor' : 'major');
      inv.action('Rephrase using these collection/field names or add a business definition that maps your term to a field.');
    } else {
      const named = (e) => overlap(fieldTokens(e.collection), qTokens) > 0;
      const selected = [ranked[0], ...ranked.slice(1).filter((e) => named(e) && named(ranked[0]) && e.collection !== ranked[0].collection).slice(0, 1)];
      for (const entry of selected) {
        try {
          await analyseCollection(inv, entry, defs.filter((d) => !d.collection || d.collection === entry.collection));
        } catch (e) {
          inv.limit(`Querying ${entry.collection} failed: ${e.message}`, 'major');
        }
      }
      if (inv.analysed.length > 1) {
        try { await analyseRelation(inv, inv.analysed[0], inv.analysed[1]); } catch (e) { inv.limit(`Cross-collection analysis failed: ${e.message}`); }
      }
    }
  }

  if (!isCommand && !scope?.only && !inv.findings.length) stackAnalysis(inv, profile);
  if (!isCommand && (!inv.findings.length || inv.stackHit)) contentAnalysis(inv, knowledge);
  if (profile?.skipped?.jsRendered?.length && !inv.findings.length) inv.limit(`This site renders its pages with JavaScript, so the crawler only saw an empty HTML shell. Connect its repository (or upload the source) for full understanding.`, 'major');
  // Once the documentation answers "How do payments work?", route lists add nothing for the asker.
  const documented = inv.findings.some((f) => f.basis === 'content') && !CODE_ASK.test(question);
  if (!isCommand && !scope?.only && codeFallback && ((intent === 'technical' && !documented) || !inv.findings.length)) technicalAnalysis(inv, profile, knowledge);
  if (!scope?.only) await runMatchingTools(inv);
  inv.step('verify', `${inv.findings.length} finding(s) checked against ${inv.evidence.length} evidence item(s)`);
  if (inv.timeRange && inv.timeNotes.size) inv.step('time_filter', `Applied ${inv.timeRange.from} → ${inv.timeRange.to} on ${[...inv.timeNotes].join(', ')}`);

  const status = inv.findings.length ? 'success' : 'insufficient_data';
  return finish(inv, started, { status });
}

async function finish(inv, started, { status, answer }) {
  const { confidence, basis } = assessConfidence(inv);
  const composed = answer || inv.options?.compose === false ? { answer: answer || deterministicAnswer(inv), mode: 'deterministic' } : await composeAnswer(inv);
  inv.step('respond', `Answer composed (${composed.mode})`);
  const result = {
    schemaVersion: SCHEMA_VERSION,
    status,
    projectId: inv.project.id,
    question: inv.question,
    intent: inv.intent,
    answer: composed.answer,
    findings: inv.findings,
    evidence: inv.evidence,
    sources: [...inv.sources.values()],
    calculations: inv.calculations,
    limitations: inv.limitations.map((l) => l.message),
    recommendedActions: inv.actions,
    proposedActions: inv.proposedActions,
    confidence,
    confidenceBasis: basis,
    timeRange: inv.timeRange,
    plan: inv.plan,
    answerMode: composed.mode,
    durationMs: Date.now() - started,
    investigatedAt: new Date().toISOString(),
  };
  if (inv.options?.record === false) return result;
  const saved = db.saveInvestigation({ projectId: inv.project.id, actor: inv.actor, question: inv.question, intent: inv.intent, status, confidence, answer: result.answer, evidenceCount: inv.evidence.length, durationMs: result.durationMs });
  result.investigationId = saved.id;
  db.addAudit({ projectId: inv.project.id, actor: inv.actor, action: 'investigate', target: inv.question.slice(0, 120), status: 'success' });
  return result;
}
