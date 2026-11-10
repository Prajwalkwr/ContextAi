// Shared behavior for decision and opinion questions across every answer provider.
export const INDEPENDENT_JUDGMENT = `Independent judgment:
- Help the user reach a sound conclusion; do not automatically agree, flatter, or repeat an assumption as fact.
- For plans, opinions, and recommendations, identify the user's objective, test the key assumption and strongest risk, consider a realistic simpler alternative, then give a clear, practical conclusion. If the idea is sound, say why; do not manufacture objections.
- Correct false claims plainly and respectfully. When disagreeing, give the strongest relevant reason and a constructive next step.
- Check that the reason for a correction is itself accurate; do not invent mechanisms or overstate certainty. For password storage, recommend salted, deliberately slow hashes (such as Argon2id or bcrypt), not plaintext or reversible encryption; explain that the deliberate hash cost is a security control, not a reason to store plaintext.
- Distinguish verified facts from assumptions, estimates, and your assessment. Apply the same accuracy standard to general technical knowledge. Support project-specific claims only with the supplied project evidence or authorized tool results; never invent research, customer behavior, statistics, or code inspection.
- Give a contextual recommendation rather than claiming one option is universally best. Explain important trade-offs and disclose missing information that could change the decision.
- Use conversation history to stay consistent when evidence is unchanged. Reconsider when meaningful new evidence or constraints arrive; explain a changed conclusion rather than defending an outdated one.
- Be concise for simple questions and analytical for consequential decisions. Be considerate in personal conversations; critical thinking is not an excuse to argue. Do not reveal private chain-of-thought; give only the brief rationale needed to support the conclusion.`;

const PASSWORD_STORAGE = /\b(password|passphrase)s?\b/i;
const CLIENT_AUTH = /\b(frontend|front-end|client[- ]side)\b/i;
const TLS = /\b(tls|ssl|certificate|certificates)\b/i;

export function knownSecurityCorrection(question) {
  const q = String(question || '');
  if (PASSWORD_STORAGE.test(q) && /\b(plain[\s-]?text|plaintext|encrypt(?:ion|ed)?|store|stored|save|hash(?:ing)?)\b/i.test(q)) {
    return 'No. Do not store plaintext or reversibly encrypted passwords. Store a unique salted password hash using a password-hashing algorithm such as Argon2id, bcrypt, or scrypt. These algorithms are deliberately costly to slow offline guessing; login verifies the submitted password by deriving and comparing its hash. Encryption is reversible, so it is not a substitute for password hashing.';
  }
  if (/\blocalstorage\b/i.test(q) && /\b(authoritative|source of truth|balance|balances|profile|profiles|sensitive)\b/i.test(q)) {
    return 'I would not use localStorage as the authoritative store for customer profiles or balances. It persists across browser restarts, but the client can read and modify it, so it cannot enforce trusted balances or permissions. Keep authoritative records on the backend; use localStorage only for suitable, non-authoritative client state.';
  }
  if (CLIENT_AUTH.test(q) && /\b(admin|authori[sz]ation|permission|permissions|access control)\b/i.test(q)) {
    return 'Frontend checks can hide controls for usability, but users can bypass them by calling the API directly. Enforce authentication and authorization on every protected server-side operation; treat client-side checks as presentation only.';
  }
  if (/\b(disabl(?:e|ing)|turn(?:ing)?\s+off|skip(?:ping)?)\b/i.test(q) && TLS.test(q)) {
    return 'Do not disable TLS certificate verification in production. It prevents the client from reliably authenticating the server and can expose traffic to interception. Diagnose the certificate hostname, expiry, trust chain, and the client’s CA store instead.';
  }
  if (/\b(store|storing|save|saving|database)\b/i.test(q) && /\b(payment|credit|debit)\s+card\s+(?:number|numbers|details|data)\b/i.test(q)) {
    return 'Storing raw payment-card data expands the security and compliance scope substantially. Prefer a payment processor that returns tokens so your application does not handle raw card numbers. Store card data only if you have deliberately designed, secured, and validated the required payment-card compliance controls.';
  }
  return null;
}
