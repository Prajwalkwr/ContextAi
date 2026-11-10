// Calibrates the retrieval relevance gate against labelled questions on a real indexed project.
// Read-only. Usage: node scripts/eval-retrieval.js [projectId]   (defaults to the first UdyogConnect)
// With OPENAI_API_KEY set and the semantic index built, similarity is reported too.
import 'dotenv/config';
import { db } from '../src/lib/db.js';
import { hybridSearch, corpusCoverage } from '../src/assistant/retrieval.js';

const PROJECT = [
  'How can I register my business?',
  'How does the nearby business recommendation work?',
  'How do bookings work?',
  'How can customers leave a review?',
  'How does authentication work?',
  'What payment methods are supported?',
  'How can I contact a business?',
  'How do I add a product to my store?',
  'How are orders placed?',
  'Who can delete a business?',
  'How do support tickets work?',
  'Can a business owner edit their business profile?',
];
const GENERAL = [
  'How many moons does Mars have?',
  'What is artificial intelligence?',
  'Explain quantum computing',
  'Help me write an email to my landlord about a broken heater',
  'What is the capital of France?',
  'Explain machine learning simply',
  'Who wrote Hamlet?',
  'What causes rainbows?',
  'Solve 2x + 5 = 11',
  'What is the boiling point of water at sea level?',
  'Translate good morning into Spanish',
  'What is photosynthesis?',
];

const pid = process.argv[2] || db.listAllProjects().find((p) => p.name === 'UdyogConnect' && db.getChunks(p.id).length)?.id;
if (!pid) { console.error('No indexed project found'); process.exit(1); }

const rows = [];
for (const [label, list] of [['project', PROJECT], ['general', GENERAL]]) {
  for (const q of list) {
    const r = await hybridSearch({ projectId: pid, query: q, semantic: !!process.env.OPENAI_API_KEY });
    const corpus = corpusCoverage(pid, q);
    rows.push({ label, q, top: r.stats.topCoverage, sim: r.stats.topSimilarity, corpus: corpus.coverage, topSource: r.results[0]?.source });
  }
}

console.log(`Project ${pid} (${db.getProject(pid).name}), ${db.getChunks(pid).length} chunks\n`);
for (const r of rows) console.log(`${r.label.padEnd(8)} top=${r.top.toFixed(2)} corpus=${r.corpus.toFixed(2)}${r.sim !== null ? ` sim=${r.sim.toFixed(2)}` : ''}  ${r.q}  [${r.topSource || '-'}]`);

function best(key) {
  let out = null;
  for (let t = 0.05; t <= 0.96; t += 0.05) {
    const correct = rows.filter((r) => (r[key] >= t) === (r.label === 'project')).length;
    if (!out || correct > out.correct) out = { t: Number(t.toFixed(2)), correct };
  }
  return `${key}: best threshold ${out.t} → ${out.correct}/${rows.length} correct`;
}
console.log(`\n${best('top')}\n${best('corpus')}`);
