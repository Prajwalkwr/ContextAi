// Creates the two validation projects through the public API (the server must be running).
// UdyogConnect is indexed from its real GitHub repository. Neither app's production database is
// available here, so both get small datasets that are explicitly flagged synthetic=true.
const API = process.env.API_URL || 'http://localhost:4000';
const EMAIL = process.env.SEED_EMAIL || 'demo@contextai.dev';
const PASSWORD = process.env.SEED_PASSWORD || 'contextai-demo';

async function call(method, path, body, token) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error || ''}`);
  return json;
}

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const day = (base, offset) => new Date(Date.parse(base) + offset * 86400000).toISOString();

function marketplaceData() {
  const r = rng(42);
  const businesses = ['Himalayan Handicrafts', 'Lalitpur Metal Works', 'Bhaktapur Pottery', 'Thamel Tea House', 'Pokhara Organics'];
  const businessRows = businesses.map((name, i) => ({ name, category: ['crafts', 'crafts', 'crafts', 'food', 'food'][i], rating: Number((3.6 + r() * 1.3).toFixed(1)), orderCount: 0 }));
  const products = Array.from({ length: 24 }, (_, i) => ({ name: `Product ${i + 1}`, business: businesses[i % 5], price: 200 + Math.round(r() * 2800), stock: r() < 0.25 ? 0 : Math.round(r() * 40) }));
  const orders = Array.from({ length: 260 }, (_, i) => {
    const business = businesses[Math.floor(r() * 5)];
    const paymentMethod = ['esewa', 'khalti', 'cod'][Math.floor(r() * 3)];
    const cancelled = r() < (paymentMethod === 'cod' ? 0.32 : 0.09);
    businessRows.find((b) => b.name === business).orderCount++;
    return {
      business,
      paymentMethod,
      status: cancelled ? 'cancelled' : r() < 0.12 ? 'pending' : 'delivered',
      cancellationReason: cancelled ? (r() < 0.2 ? null : ['customer_unreachable', 'out_of_stock', 'payment_failed'][Math.floor(r() * 3)]) : null,
      amount: 300 + Math.round(r() * 4000),
      createdAt: day('2026-08-01', Math.floor(i / 3)),
    };
  });
  const bookings = Array.from({ length: 80 }, (_, i) => ({ business: businesses[i % 5], status: r() < 0.15 ? 'no_show' : 'completed', createdAt: day('2026-08-01', i) }));
  return { businesses: businessRows, products, orders, bookings };
}

function finopsData() {
  const r = rng(7);
  const gateways = ['ConnectIPS', 'eSewa', 'Khalti', 'Fonepay'];
  const transactions = Array.from({ length: 400 }, (_, i) => {
    const gateway = gateways[i % 4];
    const d = Math.floor(i / 20);
    const degraded = gateway === 'Fonepay' && d >= 12 && d <= 14;
    const failed = r() < (degraded ? 0.5 : 0.06);
    return {
      gateway,
      status: failed ? 'failed' : 'success',
      errorCode: failed ? (degraded ? 'UPSTREAM_TIMEOUT' : ['BANK_DECLINED', 'INSUFFICIENT_FUNDS'][Math.floor(r() * 2)]) : null,
      latencyMs: Math.round(300 + r() * 250 + (degraded ? 2200 : 0)),
      amount: 100 + Math.round(r() * 20000),
      createdAt: day('2026-09-01', d),
    };
  });
  const incidents = [
    { service: 'Fonepay', severity: 'critical', summary: 'Upstream timeouts from acquiring bank', createdAt: day('2026-09-13', 0), durationMin: 190 },
    { service: 'eSewa', severity: 'minor', summary: 'Delayed settlement callback', createdAt: day('2026-09-05', 0), durationMin: 25 },
  ];
  const settlements = gateways.map((gateway, i) => ({ gateway, status: i === 3 ? 'delayed' : 'settled', amount: 500000 + i * 120000, createdAt: day('2026-09-20', 0) }));
  return { transactions, incidents, settlements };
}

async function waitForJob(token, projectId, jobId) {
  for (let i = 0; i < 240; i++) {
    const { jobs } = await call('GET', `/api/v1/projects/${projectId}/jobs`, null, token);
    const job = jobs.find((j) => j.id === jobId);
    if (job?.status === 'completed') return job;
    if (job?.status === 'failed') throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Indexing timed out');
}

async function main() {
  let auth;
  try { auth = await call('POST', '/api/v1/auth/login', { email: EMAIL, password: PASSWORD }); } catch { auth = await call('POST', '/api/v1/auth/register', { email: EMAIL, password: PASSWORD, name: 'Demo Developer' }); }
  const token = auth.token;
  const existing = (await call('GET', '/api/v1/projects', null, token)).projects;

  for (const spec of [
    {
      name: 'UdyogConnect', description: 'Local business marketplace: businesses, products, orders, bookings and reviews.', websiteUrl: 'https://udyog-connect-lyart.vercel.app/',
      repo: 'https://github.com/Prajwalkwr/UdyogConnect', data: marketplaceData(),
      definitions: [
        { term: 'unavailable', meaning: 'A product with no stock left', collection: 'products', where: [{ field: 'stock', op: 'lte', value: 0 }] },
        { term: 'order activity', meaning: 'Number of orders received by a business', collection: 'businesses', metricField: 'orderCount' },
      ],
    },
    {
      name: 'FinOpsX', description: 'Payment operations: transactions, gateways, latency, incidents and settlements.', websiteUrl: 'https://finopsx.vercel.app/dashboard',
      data: finopsData(),
      definitions: [
        { term: 'payment service', meaning: 'The payment gateway that processed a transaction', collection: 'transactions', field: 'gateway' },
        { term: 'failure', meaning: 'A transaction whose status is failed', collection: 'transactions', field: 'status', value: 'failed' },
      ],
    },
  ]) {
    if (existing.some((p) => p.name === spec.name)) { console.log(`• ${spec.name} already exists, skipping`); continue; }
    const { project, credentials } = await call('POST', '/api/v1/projects', { name: spec.name, description: spec.description, websiteUrl: spec.websiteUrl }, token);
    console.log(`• ${spec.name}: ${project.id}  publicKey ${credentials.publicKey}`);
    await call('POST', `/api/v1/projects/${project.id}/integrations`, { type: 'dataset', name: `${spec.name} synthetic sample`, synthetic: true, collections: spec.data }, token);
    for (const d of spec.definitions) await call('POST', `/api/v1/projects/${project.id}/definitions`, d, token);
    if (spec.repo) {
      const { job } = await call('POST', `/api/v1/projects/${project.id}/connect/github`, { repositoryUrl: spec.repo }, token);
      try {
        const done = await waitForJob(token, project.id, job.id);
        console.log(`  indexed ${done.result.filesIndexed} files, ${done.result.routes} routes, ${done.result.models} models from ${done.result.repository.fullName}@${done.result.repository.commit.slice(0, 7)}`);
      } catch (e) {
        console.log(`  GitHub indexing failed: ${e.message}`);
      }
    }
  }
  console.log(`\nSign in to the dashboard with ${EMAIL} / ${PASSWORD}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
