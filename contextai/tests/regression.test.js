// Regressions found by apps/api/scripts/verify-core.js on a domain the engine had never seen.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApi } from './helpers.js';

let api;
let token;
let clinic;

const appointments = [];
for (let i = 0; i < 120; i++) {
  const doctor = ['Dr. A', 'Dr. B', 'Dr. C'][i % 3];
  appointments.push({
    doctor,
    department: ['cardiology', 'dermatology', 'orthopedics'][i % 3],
    status: doctor === 'Dr. C' && i % 2 ? 'no_show' : i % 10 === 0 ? 'cancelled' : 'completed',
    waitMinutes: doctor === 'Dr. C' ? 40 : 10,
    reminderSent: i % 4 !== 0,
    scheduledAt: new Date(Date.UTC(2026, 8, 1) + Math.floor(i / 2) * 86400000).toISOString(),
  });
}
const doctors = [{ name: 'Dr. A', department: 'cardiology' }, { name: 'Dr. B', department: 'dermatology' }, { name: 'Dr. C', department: 'orthopedics' }];

const ask = async (question, extra = {}) => (await api.call('POST', `/api/v1/projects/${clinic.id}/ask`, { token, body: { question, ...extra } })).body;

before(async () => {
  api = await startApi();
  token = await api.user('regress@example.com');
  clinic = await api.project(token, 'Clinic');
  await api.call('POST', `/api/v1/projects/${clinic.id}/integrations`, { token, body: { type: 'dataset', name: 'Clinic', synthetic: true, collections: { appointments, doctors } } });
});
after(() => api.close());

test('a question term that is a stored value picks the collection holding it, not the one sharing its name', async () => {
  const r = await ask('Which doctor has the highest no-show rate?');
  const expected = appointments.filter((a) => a.doctor === 'Dr. C');
  const rate = Number(((expected.filter((a) => a.status === 'no_show').length / expected.length) * 100).toFixed(1));
  assert.match(r.answer, new RegExp(`"Dr\\. C" at ${rate}%`));
  assert.ok(r.evidence.some((e) => /appointments/.test(e.source)));
});

test('"average" by a dimension computes averages, not sums', async () => {
  const r = await ask('What is the average waitMinutes by department?');
  assert.match(r.answer, /average waitMinutes: orthopedics 40\b/);
});

test('any *At / date-typed field is used for the period filter', async () => {
  const r = await ask('How many appointments were cancelled?', { timeRange: { from: '2026-09-01', to: '2026-09-15' } });
  const inRange = appointments.filter((a) => a.scheduledAt < '2026-09-16');
  const cancelled = inRange.filter((a) => a.status === 'cancelled').length;
  assert.match(r.answer, new RegExp(`${cancelled} of ${inRange.length} appointments`));
  assert.ok(!r.limitations.some((l) => /no recognised date field/.test(l)));
});

test('a boolean field named in the question becomes the measured outcome', async () => {
  const r = await ask('What share of appointments had reminderSent?');
  const sent = appointments.filter((a) => a.reminderSent).length;
  assert.match(r.answer, new RegExp(`${sent} of ${appointments.length} appointments records \\(${Number(((sent / appointments.length) * 100).toFixed(1))}%\\) have reminderSent = "true"`));
});
