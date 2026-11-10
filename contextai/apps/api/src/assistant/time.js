const TIME_ZONES = new Map([
  ['nepal', 'Asia/Kathmandu'], ['kathmandu', 'Asia/Kathmandu'],
  ['japan', 'Asia/Tokyo'], ['tokyo', 'Asia/Tokyo'],
  ['united kingdom', 'Europe/London'], ['uk', 'Europe/London'], ['london', 'Europe/London'],
  ['new york', 'America/New_York'],
  ['los angeles', 'America/Los_Angeles'], ['san francisco', 'America/Los_Angeles'],
  ['india', 'Asia/Kolkata'], ['mumbai', 'Asia/Kolkata'], ['delhi', 'Asia/Kolkata'],
  ['china', 'Asia/Shanghai'], ['beijing', 'Asia/Shanghai'], ['singapore', 'Asia/Singapore'],
  ['thailand', 'Asia/Bangkok'], ['bangkok', 'Asia/Bangkok'],
  ['australia', 'Australia/Sydney'], ['sydney', 'Australia/Sydney'],
  ['new zealand', 'Pacific/Auckland'], ['auckland', 'Pacific/Auckland'],
  ['france', 'Europe/Paris'], ['paris', 'Europe/Paris'],
  ['germany', 'Europe/Berlin'], ['berlin', 'Europe/Berlin'],
  ['uae', 'Asia/Dubai'], ['dubai', 'Asia/Dubai'],
  ['utc', 'UTC'], ['gmt', 'UTC'],
]);

const DIRECT_TIME = /^\s*what(?:'s|\s+is)?\s+(?:the\s+)?(?:current\s+)?(?:time|date|day)(?:\s+is\s+it)?(?:\s+(?:in|for)\s+[a-z0-9_ /-]+)?(?:\s+(?:now|today|right\s+now))?\s*[?.!,]*\s*$/i;
const TODAY_DATE = /^\s*(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:today'?s\s+date|date\s+today)|today'?s\s+date)(?:\s+(?:in|for)\s+[a-z0-9_ /-]+)?\s*[?.!,]*\s*$/i;
const TIME_UNTIL = /^\s*(?:how\s+long\s+until|time\s+until)\b/i;
const TIME_DIFFERENCE_QUESTION = /^\s*(?:what(?:'s|\s+is)?\s+(?:the\s+)?(?:current\s+)?time\s+difference\s+between\s+.+|time\s+difference\s+between\s+.+)\s*[?.!,]*\s*$/i;
const WEEKDAY_QUESTION = /^\s*what\s+day\s+of\s+the\s+week\b.*[?.!,]*\s*$/i;
const NAMED_TIME = /^\s*(?:current\s+)?time\s+in\s+[a-z0-9_ /-]+\s*[?.!,]*\s*$/i;
const BARE_TIME = /^\s*(?:tell\s+me\s+)?the\s+(?:current\s+)?(?:time|date)\s*[?.!,]*\s*$/i;
const DATE_LITERAL = /\b(?:\d{4}-\d{2}-\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?)\b/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function timeZoneIn(text) {
  const iana = text.match(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g) || [];
  for (const zone of iana) if (validTimeZone(zone)) return zone;

  const lower = text.toLowerCase();
  const matches = [...TIME_ZONES.entries()]
    .filter(([name]) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower))
    .sort(([a], [b]) => b.length - a.length);
  return matches[0]?.[1] || null;
}

function requestedLocation(text) {
  return text.match(/\b(?:in|for)\s+([A-Za-z][A-Za-z0-9_ /-]*?)(?:\s+(?:right\s+now|now|today))?[?.!,]*$/i)?.[1]?.trim() || null;
}

function offsetMinutes(instant, timeZone) {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = /GMT([+-])(\d{1,2}):(\d{2})/.exec(zone);
  if (!match) return 0;
  const value = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -value : value;
}

function offsetLabel(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function zoneLabel(instant, timeZone) {
  if (timeZone === 'Asia/Kathmandu') return 'NPT';
  const value = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(instant).find((part) => part.type === 'timeZoneName')?.value;
  return value && !/^GMT[+-]/.test(value) ? value : offsetLabel(offsetMinutes(instant, timeZone));
}

function dateAndTime(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).formatToParts(instant);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    weekday: get('weekday'),
    date: `${get('month')} ${get('day')}, ${get('year')}`,
    time: `${get('hour')}:${get('minute')} ${get('dayPeriod')}`,
  };
}

function parseDate(text, now) {
  const found = text.match(DATE_LITERAL)?.[0];
  if (!found) return null;
  let year;
  let month;
  let day;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(found);
  if (match) [, year, month, day] = match;
  else {
    match = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(found);
    if (match) [, month, day, year] = match;
    else {
      match = /^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/i.exec(found);
      if (match) [, day, month, year] = match;
    }
    if (!match) return null;
    month = MONTHS.findIndex((value) => value.startsWith(month.toLowerCase())) + 1;
    if (!month) return null;
    year ||= now.getUTCFullYear();
  }
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (parsed.getUTCFullYear() !== Number(year) || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)) return null;
  return parsed;
}

function currentAnswer({ instant, timeZone, location, kind }) {
  const formatted = dateAndTime(instant, timeZone);
  const zone = zoneLabel(instant, timeZone);
  const offset = offsetLabel(offsetMinutes(instant, timeZone));
  const target = location ? ` in ${location}` : '';
  if (kind === 'date') return `Today's date${target} is ${formatted.date} (${formatted.weekday}, ${zone}, ${offset}).`;
  if (kind === 'day') return `It is ${formatted.weekday}${target} (${formatted.date}, ${zone}, ${offset}).`;
  return `The current time${target} is ${formatted.time} (${formatted.date}, ${zone}, ${offset}).`;
}

function instantAtLocalMidnight(date, timeZone) {
  const midnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  let instant = midnightUtc;
  for (let i = 0; i < 2; i++) instant = midnightUtc - offsetMinutes(new Date(instant), timeZone) * 60_000;
  return instant;
}

export function answerTimeQuestion(question, { defaultTimeZone = 'UTC', now = new Date() } = {}) {
  const text = String(question || '').trim();
  const timeDifference = TIME_DIFFERENCE_QUESTION.test(text);
  const weekdayQuestion = WEEKDAY_QUESTION.test(text);
  const timeUntil = TIME_UNTIL.test(text);
  if (!DIRECT_TIME.test(text) && !TODAY_DATE.test(text) && !timeDifference && !weekdayQuestion && !NAMED_TIME.test(text) && !BARE_TIME.test(text) && !timeUntil) return null;

  if (timeUntil) {
    const date = parseDate(text, now);
    if (!date) return null;
    const timeZone = timeZoneIn(text) || (requestedLocation(text) ? null : defaultTimeZone);
    if (!timeZone) return { answer: 'I could not identify that time zone. Please specify a city or an IANA time-zone identifier such as Asia/Kathmandu.', timeZone: null, kind: 'clarification' };
    if (!validTimeZone(timeZone)) return { answer: 'The project time zone is not configured correctly. Please contact the project administrator.', timeZone: null, kind: 'configuration_error' };
    const remaining = instantAtLocalMidnight(date, timeZone) - now.getTime();
    if (remaining < 0) return { answer: `${date.toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'long' })} has already passed in ${timeZone}.`, timeZone, kind: 'countdown' };
    const days = Math.floor(remaining / 86_400_000);
    const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    const parts = [days && `${days} day${days === 1 ? '' : 's'}`, hours && `${hours} hour${hours === 1 ? '' : 's'}`, minutes && `${minutes} minute${minutes === 1 ? '' : 's'}`].filter(Boolean);
    return { answer: `${parts.join(', ') || 'Less than a minute'} until ${date.toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'long' })} in ${timeZone}.`, timeZone, kind: 'countdown' };
  }

  if (timeDifference) {
    const pair = text.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!,]|$)/i);
    if (!pair) return null;
    const from = timeZoneIn(pair[1]);
    const to = timeZoneIn(pair[2]);
    if (!from || !to) return null;
    const delta = offsetMinutes(now, to) - offsetMinutes(now, from);
    const hours = Math.floor(Math.abs(delta) / 60);
    const minutes = Math.abs(delta) % 60;
    const duration = [hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '', minutes ? `${minutes} minute${minutes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ') || 'no time difference';
    const relation = delta > 0 ? `${duration} ahead of ${pair[1].trim()}` : delta < 0 ? `${duration} behind ${pair[1].trim()}` : `the same time as ${pair[1].trim()}`;
    return { answer: `As of now, ${pair[2].trim()} is ${relation} (${offsetLabel(offsetMinutes(now, to))} vs ${offsetLabel(offsetMinutes(now, from))}).`, timeZone: to, kind: 'difference' };
  }

  if (weekdayQuestion) {
    const parsed = parseDate(text, now);
    if (!parsed) return null;
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(parsed);
    const date = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(parsed);
    return { answer: `${date} is a ${weekday}.`, timeZone: 'UTC', kind: 'weekday' };
  }

  const requestedZone = timeZoneIn(text);
  const location = requestedLocation(text);
  if (location && !requestedZone) return { answer: 'I could not identify that time zone. Please specify a city or an IANA time-zone identifier such as Asia/Kathmandu.', timeZone: null, kind: 'clarification' };
  const timeZone = requestedZone || defaultTimeZone;
  if (!validTimeZone(timeZone)) return { answer: 'The project time zone is not configured correctly. Please contact the project administrator.', timeZone: null, kind: 'configuration_error' };
  const dateQuestion = TODAY_DATE.test(text) || /\b(?:current\s+date|date\s+in)\b/i.test(text) || /\bdate\b/i.test(text);
  const dayQuestion = !dateQuestion && /\b(?:what day|day of the week)\b/i.test(text);
  return {
    answer: currentAnswer({ instant: now, timeZone, location, kind: dateQuestion ? 'date' : dayQuestion ? 'day' : 'time' }),
    timeZone,
    kind: dateQuestion ? 'date' : dayQuestion ? 'day' : 'time',
  };
}
