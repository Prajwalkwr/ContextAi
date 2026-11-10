// When the public web may be searched, and with which provider. Search is never a substitute for
// the project's own sources: its records, health checks and code are read through their tools,
// and only questions about the outside world (or verification of general facts) reach the web.
import { llm } from '../lib/llm.js';
import { googleSearch } from '../lib/googleSearch.js';
import { healthFocus } from './health.js';
import { entityIn } from './tools.js';
import { understandingText } from './nlu.js';

const RECORD_ASK = /\b(how many|number of|count|total|average|highest|lowest|most|least|top|best|worst|rank(ing)?|cheapest|most expensive)\b/i;

// 'google' (Gemini grounding), 'openai' (Responses API hosted web search) or null.
export function webProvider(config) {
  if (config && !config.searchConfiguration?.webSearch) return null;
  const wanted = (process.env.WEB_SEARCH_PROVIDER || 'auto').toLowerCase();
  if (wanted === 'none' || wanted === 'off') return null;
  const google = googleSearch.isEnabled();
  const openai = llm.supportsWebSearch();
  if (wanted === 'google') return google ? 'google' : null;
  if (wanted === 'openai') return openai ? 'openai' : null;
  return google ? 'google' : openai ? 'openai' : null;
}

// need: 'none' (answer from the project or the conversation; never search),
//       'required' (current or time-sensitive external information),
//       'optional' (general knowledge; a model may search to verify).
// strict: the answer lives in the project's own data, health checks or code, so the web must not
// be used even if a model router asks for it.
export function searchNeed({ question, signals: s, history = [] }) {
  const meaning = s.understandingText || understandingText(question).interpreted;
  const none = (reason, strict = true) => ({ need: 'none', reason, strict });
  if (s.smallTalk) return none('greeting or small talk', false);
  if (!s.dataMatches.length && healthFocus(meaning)) return none('live status of this project is checked directly, not searched');
  if (s.personal || s.command) return none('the user\'s own records or an action on project data');
  const recordsAsk = RECORD_ASK.test(meaning) && !!entityIn(meaning.toLowerCase()) && !s.current && !s.generalSubject;
  if (s.dataMatches.length || s.definitionHit || s.listsRecords || recordsAsk) return none('answered from the project\'s connected data, not the web');
  if (s.implementation) return none('asks how this project is built');
  if (s.current) return { need: 'required', reason: s.projectMention ? 'needs current external information alongside project facts' : 'asks for recent or time-sensitive external information' };
  const prev = history.at(-1);
  if (s.followUp && (prev?.grounded || prev?.sources?.includes('web_search'))) return { need: 'required', reason: 'continues a web-research conversation' };
  if (s.projectMention || s.structureHit) return none('about the project itself', false);
  return { need: 'optional', reason: 'general knowledge; a search may verify it' };
}

// Below this share of a question's (IDF-weighted) words occurring anywhere in the project, it is
// about something else. Measured on UdyogConnect: project questions 1.00, general ones 0.00-0.63.
const GENERAL_MAX_CORPUS = Number(process.env.ASSISTANT_GENERAL_MAX_CORPUS) || 0.7;
const ADDRESSES_SITE = /\b(i|we|you|your|yours|my|us|our|here)\b/i;

// General knowledge with nothing project-specific in it ("What is the capital of Australia?"):
// answered directly, without project tools a small model might reach for instead.
export function generalOnly({ question, signals: s, history = [] }) {
  const meaning = s.understandingText || understandingText(question).interpreted;
  // With nothing indexed there is no measure of what the project covers.
  const need = searchNeed({ question: meaning, signals: s, history });
  if (s.corpus.empty || need.need === 'required' || need.strict) return false;
  if (s.followUp || s.projectMention || s.dataMatches.length) return false;
  if (entityIn(meaning.toLowerCase())) return false;
  if (GENERAL_TASK.test(meaning)) return true;
  if (need.need !== 'optional' || s.structureHit) return false;
  if (ADDRESSES_SITE.test(meaning.replace(/(["“'‘])[^"”'’]*["”'’]/g, ' '))) return false;
  if (s.corpus.coverage < GENERAL_MAX_CORPUS) return true;
  // Words found only inside source code ("Why is the sky blue?" vs. CSS colour classes) don't make
  // a question about the project; "is there…" still asks about the site.
  return !ASKS_IF_SITE_HAS.test(meaning) && (s.corpus.prose ?? 1) < GENERAL_MAX_CORPUS;
}
const ASKS_IF_SITE_HAS = /^\s*(?:is|are)\s+there\b/i;

// Tasks on the user's own text or about the world, whatever words the project happens to share.
const GENERAL_TASK = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+|help\s+me\s+)?(?:translate|calculate|compute|solve|convert|spell|summari[sz]e|paraphrase|rephrase|proofread|write\s+(?:me\s+)?(?:a|an|some)\s+(?:poem|story|haiku|joke|song|essay|limerick|letter|email|riddle|caption|tweet|slogan)|tell\s+me\s+(?:a|an)\s+(?:joke|story|fun\s+fact|riddle))\b/i;

// Grounded Results may be resubmitted only to Google. Other models see that the turn happened
// and what it was about, not the grounded text.
export function forOtherModels(history) {
  return history.map((t) => (t.grounded
    ? { ...t, answer: `(Answered with live Google Search results that were shown to the user with their sources. Topic: ${String(t.standalone || t.question).slice(0, 300)})` }
    : t));
}
