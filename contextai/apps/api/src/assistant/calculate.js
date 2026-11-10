// Arithmetic, percentages and unit conversions computed exactly: small models get these wrong.
// Returns the answer text, or null when the question isn't a plain calculation.

const UNITS = {
  length: { km: 1000, m: 1, cm: 0.01, mm: 0.001, mile: 1609.344, yard: 0.9144, foot: 0.3048, inch: 0.0254 },
  mass: { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.028349523125, tonne: 1000 },
  volume: { l: 1, ml: 0.001, gallon: 3.785411784 },
};
const ALIASES = {
  km: 'km', kms: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
  m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
  cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  mm: 'mm', millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  mile: 'mile', miles: 'mile', mi: 'mile', yard: 'yard', yards: 'yard', yd: 'yard',
  foot: 'foot', feet: 'foot', ft: 'foot', inch: 'inch', inches: 'inch',
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg', g: 'g', gram: 'g', grams: 'g', mg: 'mg', milligram: 'mg', milligrams: 'mg',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', oz: 'oz', ounce: 'oz', ounces: 'oz', tonne: 'tonne', tonnes: 'tonne',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l', ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  gallon: 'gallon', gallons: 'gallon',
  c: 'c', celsius: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k',
};
const NAMES = { km: ['kilometre', 'kilometres'], m: ['metre', 'metres'], cm: ['centimetre', 'centimetres'], mm: ['millimetre', 'millimetres'], mile: ['mile', 'miles'], yard: ['yard', 'yards'], foot: ['foot', 'feet'], inch: ['inch', 'inches'], kg: ['kilogram', 'kilograms'], g: ['gram', 'grams'], mg: ['milligram', 'milligrams'], lb: ['pound', 'pounds'], oz: ['ounce', 'ounces'], tonne: ['tonne', 'tonnes'], l: ['litre', 'litres'], ml: ['millilitre', 'millilitres'], gallon: ['US gallon', 'US gallons'], c: ['°C', '°C'], f: ['°F', '°F'], k: ['K', 'K'] };

const fmt = (n) => {
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e15 || (n !== 0 && Math.abs(n) < 1e-6)) return n.toExponential(4);
  return n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 1 ? 6 : 4 });
};
const unitName = (u, n) => (NAMES[u][Math.abs(n) === 1 ? 0 : 1]);

function convertTemp(v, from, to) {
  const c = from === 'c' ? v : from === 'f' ? (v - 32) * 5 / 9 : v - 273.15;
  return to === 'c' ? c : to === 'f' ? c * 9 / 5 + 32 : c + 273.15;
}

function convert(value, fromWord, toWord) {
  const from = ALIASES[fromWord.toLowerCase()], to = ALIASES[toWord.toLowerCase()];
  if (!from || !to || from === to) return null;
  const temps = ['c', 'f', 'k'];
  let result;
  if (temps.includes(from) || temps.includes(to)) {
    if (!(temps.includes(from) && temps.includes(to))) return null;
    result = convertTemp(value, from, to);
  } else {
    const dim = Object.values(UNITS).find((d) => from in d && to in d);
    if (!dim) return null;
    result = value * dim[from] / dim[to];
  }
  const v = fmt(value), r = fmt(result);
  return v && r ? `${v} ${unitName(from, value)} is ${r} ${unitName(to, result)}.` : null;
}

// Recursive descent over + - * / ^ and parentheses; nothing is evaluated as code.
function evaluate(expr) {
  const src = expr.replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/,(?=\d{3}\b)/g, '').replace(/\s+/g, '');
  if (!/^[\d.+\-*/^()]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const number = () => {
    const m = /^\d*\.?\d+/.exec(src.slice(i));
    if (!m) throw new Error('number');
    i += m[0].length;
    return Number(m[0]);
  };
  const atom = () => {
    if (peek() === '-') { i++; return -atom(); }
    if (peek() === '(') { i++; const v = sum(); if (src[i++] !== ')') throw new Error('paren'); return v; }
    return number();
  };
  const power = () => { const b = atom(); if (peek() === '^') { i++; return b ** power(); } return b; };
  const product = () => {
    let v = power();
    while (peek() === '*' || peek() === '/') { const op = src[i++]; const r = power(); v = op === '*' ? v * r : v / r; }
    return v;
  };
  const sum = () => {
    let v = product();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = product(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  try {
    const v = sum();
    return i === src.length ? v : null;
  } catch {
    return null;
  }
}

const NUM = '(-?\\d[\\d,]*(?:\\.\\d+)?)';
const UNIT = '([a-z°]+)';
const LEAD = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:what(?:'s|\s+is|\s+are)|calculate|compute|solve|work\s+out|how\s+much\s+is|convert|tell\s+me)?\s*/i;
const num = (s) => Number(s.replace(/,/g, ''));

export function calculate(question) {
  const q = question.trim().replace(/[?!.]+$/, '').replace(/°\s*/g, '');
  const body = q.replace(LEAD, '');

  const pct = new RegExp(`^${NUM}\\s*(?:%|percent)\\s+of\\s+${NUM}$`, 'i').exec(body);
  if (pct) {
    const r = fmt(num(pct[1]) / 100 * num(pct[2]));
    return r && `${fmt(num(pct[1]))}% of ${fmt(num(pct[2]))} is ${r}.`;
  }

  const conv = new RegExp(`^${NUM}\\s*${UNIT}\\s+(?:to|in|into)\\s+${UNIT}$`, 'i').exec(body);
  if (conv) return convert(num(conv[1]), conv[2], conv[3]);
  const many = new RegExp(`^how\\s+many\\s+${UNIT}\\s+(?:(?:is|are)\\s+(?:there\\s+)?(?:in\\s+)?|in\\s+|make\\s+)${NUM}\\s*${UNIT}$`, 'i').exec(q);
  if (many) return convert(num(many[2]), many[3], many[1]);

  // A bare expression with at least one operator between numbers ("23 * 47", "(3+4)^2").
  if (/\d\s*[-+*/x×÷^]\s*[\d(]/.test(body) && /^[\d\s.,+\-*/x×÷^()]+$/.test(body)) {
    const v = evaluate(body);
    const r = v === null ? null : fmt(v);
    return r && `${body.trim().replace(/\s+/g, ' ')} = ${r}`;
  }
  return null;
}
