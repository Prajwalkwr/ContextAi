// Conservative, local interpretation aids for heuristic routing and retrieval.
// The original message is never changed; these forms are only supplemental signals.
const TYPO_ALIASES = new Map(Object.entries({
  wat: 'what',
  wht: 'what',
  whch: 'which',
  busness: 'business',
  busines: 'business',
  ratng: 'rating',
  reviw: 'review',
  reviws: 'reviews',
  revies: 'reviews',
  curent: 'current',
  crnt: 'current',
  teh: 'the',
  th: 'the',
  workng: 'working',
  workin: 'working',
  oder: 'order',
  odr: 'order',
  wher: 'where',
  cn: 'can',
  culd: 'could',
  regist: 'register',
  regster: 'register',
  regstr: 'register',
  logn: 'login',
  loggin: 'login',
  paymnt: 'payment',
  paymant: 'payment',
  thro: 'through',
  throug: 'through',
  availble: 'available',
  availabl: 'available',
  servce: 'service',
  webiste: 'website',
  wbesite: 'website',
  explan: 'explain',
  explane: 'explain',
  plz: 'please',
  pls: 'please',
  thx: 'thanks',
}));

const ROMANIZED_NEPALI = [
  [/\byo\s+website\s+ko\s+naam\s+k\s+ho\b/giu, 'what is the name of this website'],
  [/\baile\s+nepal\s+ma\s+kati\s+bajyo\b/giu, 'what is the current time in Nepal'],
  [/\bmero\s+order\s+kaha\s+pugyo\b/giu, 'where has my order reached'],
  [/\bkun\s+business\s+ko\s+rating\s+(?:sabai\s+vanda\s+)?high\s+xa\b/giu, 'which business has the highest rating'],
  [/\bkati\s+ota\s+reviews?\s+xa\b/giu, 'how many reviews are there'],
  [/\bpayment\s+kasari\s+garne\b/giu, 'how do I make a payment'],
  [/\baile\s+service\s+chalirako\s+xa\b/giu, 'is the service running right now'],
  [/\bmalai\s+login\s+garna\s+mildaina\b/giu, 'I cannot log in'],
  [/\byo\s+error\s+kina\s+aayo\b/giu, 'why did this error occur'],
  [/\besko\s+barema\s+explain\s+gara\b/giu, 'explain this'],
  [/\bali\s+simple\s+language\s+ma\s+vana\b/giu, 'explain in simpler language'],
];

const DEVANAGARI_NEPALI = [
  [/यो\s+वेबसाइटको?\s+नाम\s+के\s+हो/gu, 'what is the name of this website'],
  [/अहिले\s+नेपालमा\s+कति\s+बज्यो/gu, 'what is the current time in Nepal'],
  [/मेरो\s+अर्डर\s+कहाँ\s+पुग्यो/gu, 'where has my order reached'],
  [/कुन\s+बिजनेसको?\s+रेटिङ\s+(?:सबैभन्दा\s+)?उच्च\s+छ/gu, 'which business has the highest rating'],
  [/कति\s+वटा\s+रिभ्यु\s+छन्/gu, 'how many reviews are there'],
  [/भुक्तानी\s+कसरी\s+गर्ने/gu, 'how do I make a payment'],
  [/अहिले\s+सेवा\s+चलिरहेको\s+छ/gu, 'is the service running right now'],
  [/मलाई\s+लगइन\s+गर्न\s+मिल्दैन/gu, 'I cannot log in'],
  [/यो\s+त्रुटि\s+किन\s+आयो/gu, 'why did this error occur'],
  [/यसको\s+बारेमा\s+व्याख्या\s+गर/gu, 'explain this'],
  [/अलि\s+सरल\s+भाषामा\s+भन/gu, 'explain in simpler language'],
];

const NEPALI_MARKERS = new Set([
  'yo', 'ko', 'naam', 'kun', 'xa', 'chha', 'cha', 'kaha', 'kati', 'ota', 'ma', 'bajyo',
  'mero', 'kasari', 'aile', 'ahile', 'aaja', 'kina', 'malai', 'garna', 'garne', 'mildaina', 'pugyo',
  'esko', 'barema', 'ali', 'vana', 'van', 'bhan', 'bhandinu',
]);
const ENGLISH_CUES = new Set([
  'website', 'business', 'rating', 'reviews', 'review', 'order', 'payment',
  'service', 'login', 'error', 'admin', 'product', 'booking',
]);

export function detectInputLanguage(message) {
  const text = String(message || '');
  const hasDevanagari = /[\u0900-\u097f]/u.test(text);
  const hasLatin = /[a-z]/i.test(text);
  if (hasDevanagari) return hasLatin ? 'mixed Nepali-English' : 'Nepali';

  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  const nepaliMarkers = words.filter((word) => NEPALI_MARKERS.has(word)).length;
  if (nepaliMarkers >= 2) {
    return words.some((word) => ENGLISH_CUES.has(word)) ? 'mixed Nepali-English (Romanized)' : 'Romanized Nepali';
  }
  return 'English';
}

export function understandingText(message) {
  const original = String(message || '').normalize('NFKC');
  let interpreted = original;
  const language = detectInputLanguage(original);

  if (language.includes('Nepali')) {
    for (const [pattern, replacement] of ROMANIZED_NEPALI) interpreted = interpreted.replace(pattern, replacement);
  }
  if (language.includes('Nepali') && /[\u0900-\u097f]/u.test(original)) {
    for (const [pattern, replacement] of DEVANAGARI_NEPALI) interpreted = interpreted.replace(pattern, replacement);
  }

  interpreted = interpreted.replace(/\b[a-z]+\b/gi, (word) => TYPO_ALIASES.get(word.toLowerCase()) || word);
  return { original, interpreted, language };
}
