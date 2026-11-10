// Input and output safety checks. Retrieved project content is always treated as untrusted data;
// these checks additionally stop direct requests for secrets and instruction-override attempts
// before any model or tool is called, and scrub secrets from anything leaving the server.

const OVERRIDE = /\b(ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(previous|prior|above|earlier|all|any|system|your|the)\b[^.?!]{0,30}\b(instructions?|prompts?|rules?|guidelines?|polic(y|ies))\b/i;
const SECRET_NOUN = String.raw`(api[\s_-]?keys?|secret[\s_-]?keys?|secrets|private[\s_-]?keys?|access[\s_-]?tokens?|bearer[\s_-]?tokens?|passwords?|credentials|env(?:ironment)?[\s_-]?(?:variables?|vars?)|\.env\b|jwt[\s_-]?secret|encryption[\s_-]?key|connection[\s_-]?strings?|system[\s_-]?prompt|hidden[\s_-]?instructions|developer[\s_-]?message)`;
const REVEAL = String.raw`\b(reveal|show|print|dump|leak|expose|give|tell|send|output|display|share|list|read|repeat|what(?:'s|\s+is|\s+are))\b[^.?!]{0,40}`;
const SECRET_REQUEST = new RegExp(`${REVEAL}\\b${SECRET_NOUN}`, 'i');
// Environment-variable style names such as OPENAI_API_KEY or DB_PASSWORD.
const ENV_NAME_REQUEST = new RegExp(`${REVEAL}\\b[A-Za-z][A-Za-z0-9]*_(?:[A-Za-z0-9]+_)*(key|secret|token|password|pass|pwd)\\b`, 'i');
// "How are API keys validated?" is a legitimate question about the project's implementation.
const HOW_IT_WORKS = /\b(how|where|why)\b[^.?!]{0,60}\b(work|works|implemented|stored|handled|validated|verified|generated|hashed|rotated|used|configured|checked)\b/i;

export function inspectInput(question) {
  if (OVERRIDE.test(question)) {
    return { blocked: true, category: 'instruction_override', message: 'I can’t follow requests to ignore or change my instructions. Ask me a question about this project or anything else, and I’ll help.' };
  }
  if ((SECRET_REQUEST.test(question) || ENV_NAME_REQUEST.test(question)) && !HOW_IT_WORKS.test(question)) {
    return { blocked: true, category: 'secret_request', message: 'I can’t reveal API keys, passwords, tokens, environment variables or my system instructions. If you need a credential, get it from the project owner’s secure configuration.' };
  }
  return { blocked: false };
}

const SECRET_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bsk_[a-f0-9]{32,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(mongodb(\+srv)?|postgres(ql)?|mysql):\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

function envSecrets() {
  return Object.entries(process.env)
    .filter(([k, v]) => /KEY|SECRET|TOKEN|PASSWORD/i.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v);
}

export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const v of envSecrets()) out = out.split(v).join('[redacted]');
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[redacted]');
  return out;
}

// Wraps project or web content so the model sees it as data, never as instructions.
export const untrusted = (label, text) => `<untrusted_${label}>\n${redactSecrets(text)}\n</untrusted_${label}>`;
