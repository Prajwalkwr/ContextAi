// Short-term conversation memory. Conversations are bound to (project, caller) so one user can
// never read or continue another user's conversation by guessing its id.
import { randomUUID } from 'crypto';

const TTL_MS = Number(process.env.CONVERSATION_TTL_MS) || 2 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 5000;
const MAX_TURNS = 20;
const conversations = new Map();

const keyOf = (projectId, actor, id) => `${projectId}\u0000${actor}\u0000${id}`;

function prune() {
  const now = Date.now();
  for (const [k, c] of conversations) if (c.expiresAt < now) conversations.delete(k);
  while (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
}

export function getConversation(projectId, actor, id) {
  prune();
  const conversationId = id || `conv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const k = keyOf(projectId, actor, conversationId);
  if (!conversations.has(k)) conversations.set(k, { id: conversationId, turns: [], expiresAt: Date.now() + TTL_MS });
  return conversations.get(k);
}

export function appendTurn(conversation, turn) {
  conversation.turns.push(turn);
  if (conversation.turns.length > MAX_TURNS) conversation.turns.splice(0, conversation.turns.length - MAX_TURNS);
  conversation.expiresAt = Date.now() + TTL_MS;
}

// Most recent turns that fit a character budget (≈ tokens × 4), newest kept first.
export function historyWindow(turns, { maxTurns = 20, maxChars = 12000 } = {}) {
  const out = [];
  let used = 0;
  for (const t of [...turns].reverse().slice(0, maxTurns)) {
    const q = t.question.slice(0, 800);
    const a = (t.answer || '').slice(0, 1000);
    const standalone = t.standalone ? String(t.standalone).slice(0, 800) : undefined;
    const size = q.length + a.length + (standalone?.length || 0);
    if (used + size > maxChars) break;
    used += size;
    out.unshift({ ...t, question: q, answer: a, standalone });
  }
  return out;
}
