import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerTimeQuestion } from '../apps/api/src/assistant/time.js';
import { understandingText } from '../apps/api/src/assistant/nlu.js';

test('current time and date use the requested IANA time zone', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');
  const current = answerTimeQuestion('What is the current time in Nepal?', { now });
  assert.equal(current.timeZone, 'Asia/Kathmandu');
  assert.match(current.answer, /5:45 PM/);
  assert.match(current.answer, /NPT, UTC\+05:45/);
  assert.match(answerTimeQuestion("What's the date today in Tokyo?", { now }).answer, /January 15, 2026/);
});

test('timezone differences account for daylight-saving offsets at the requested instant', () => {
  const winter = answerTimeQuestion('What is the time difference between Nepal and London?', { now: new Date('2026-01-15T12:00:00.000Z') });
  assert.match(winter.answer, /London is 5 hours and 45 minutes behind Nepal/);
  const summer = answerTimeQuestion('What is the time difference between Nepal and London?', { now: new Date('2026-07-15T12:00:00.000Z') });
  assert.match(summer.answer, /London is 4 hours and 45 minutes behind Nepal/);
});

test('date questions calculate weekdays without a model', () => {
  assert.equal(answerTimeQuestion('What day of the week is 2026-11-07?').answer, 'November 7, 2026 is a Saturday.');
});

test('does not silently use the project time zone for an unrecognized location', () => {
  const result = answerTimeQuestion('What is the current time in Brazil?', { defaultTimeZone: 'UTC' });
  assert.equal(result.kind, 'clarification');
  assert.match(result.answer, /specify a city or an IANA time-zone identifier/);
});

test('date countdowns use local midnight in the selected zone', () => {
  const result = answerTimeQuestion('How long until January 16, 2026?', {
    now: new Date('2026-01-15T12:00:00.000Z'),
    defaultTimeZone: 'Asia/Kathmandu',
  });
  assert.match(result.answer, /6 hours, 15 minutes until January 16, 2026 in Asia\/Kathmandu/);
});

test('understands Nepali time questions but always answers in English', () => {
  const input = understandingText('aile nepal ma kati bajyo?');
  assert.equal(input.interpreted, 'what is the current time in Nepal?');
  assert.match(answerTimeQuestion(input.interpreted).answer, /The current time in Nepal is/);
  const nepali = understandingText('अहिले नेपालमा कति बज्यो');
  assert.match(answerTimeQuestion(nepali.interpreted).answer, /The current time in Nepal is/);
  assert.doesNotMatch(answerTimeQuestion(nepali.interpreted).answer, /[\u0900-\u097f]/u);
  assert.equal(answerTimeQuestion('What time do orders get delivered?'), null);
});
