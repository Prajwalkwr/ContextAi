import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { historyWindow } from '../apps/api/src/assistant/conversation.js';
import { asksCurrent, isClockQuestion, isFollowUp, smallTalkKind } from '../apps/api/src/assistant/router.js';
import { detectInputLanguage, understandingText } from '../apps/api/src/assistant/nlu.js';

const typoWords = [
  ['wat', 'what'], ['wht', 'what'], ['whch', 'which'], ['busness', 'business'], ['busines', 'business'],
  ['ratng', 'rating'], ['reviw', 'review'], ['reviws', 'reviews'], ['revies', 'reviews'],
  ['curent', 'current'], ['crnt', 'current'], ['teh', 'the'], ['workng', 'working'], ['workin', 'working'],
  ['oder', 'order'], ['odr', 'order'], ['wher', 'where'], ['cn', 'can'], ['culd', 'could'],
  ['regist', 'register'], ['regster', 'register'], ['regstr', 'register'], ['logn', 'login'], ['loggin', 'login'],
  ['paymnt', 'payment'], ['paymant', 'payment'], ['thro', 'through'], ['throug', 'through'],
  ['availble', 'available'], ['availabl', 'available'], ['servce', 'service'],
  ['webiste', 'website'], ['wbesite', 'website'], ['explan', 'explain'], ['explane', 'explain'],
  ['plz', 'please'], ['pls', 'please'], ['thx', 'thanks'],
];

const romanizedNepali = [
  ['yo website ko naam k ho', 'what is the name of this website'],
  ['mero order kaha pugyo', 'where has my order reached'],
  ['kun business ko rating sabai vanda high xa', 'which business has the highest rating'],
  ['kati ota reviews xa', 'how many reviews are there'],
  ['payment kasari garne', 'how do I make a payment'],
  ['aile service chalirako xa', 'is the service running right now'],
  ['malai login garna mildaina', 'I cannot log in'],
  ['yo error kina aayo', 'why did this error occur'],
  ['esko barema explain gara', 'explain this'],
  ['ali simple language ma vana', 'explain in simpler language'],
];

const devanagariNepali = [
  ['यो वेबसाइटको नाम के हो', 'what is the name of this website'],
  ['मेरो अर्डर कहाँ पुग्यो', 'where has my order reached'],
  ['कुन बिजनेसको रेटिङ सबैभन्दा उच्च छ', 'which business has the highest rating'],
  ['कति वटा रिभ्यु छन्', 'how many reviews are there'],
  ['भुक्तानी कसरी गर्ने', 'how do I make a payment'],
  ['अहिले सेवा चलिरहेको छ', 'is the service running right now'],
  ['मलाई लगइन गर्न मिल्दैन', 'I cannot log in'],
  ['यो त्रुटि किन आयो', 'why did this error occur'],
  ['यसको बारेमा व्याख्या गर', 'explain this'],
  ['अलि सरल भाषामा भन', 'explain in simpler language'],
];

const englishMessages = [
  'How do I register a business?',
  'Which business has the highest rating?',
  'Is the website currently available?',
  'Where can I find the payment policy?',
  'Can you explain how bookings work?',
  'What is the latest service update?',
  'How many orders were placed today?',
  'Show me the most recent reviews.',
  'Why did the checkout fail?',
  'What does this platform do?',
  'Please explain this in simple language.',
  'Can customers pay with a card?',
  'What happens when the database is unavailable?',
  'How do I change my account details?',
  'Tell me which product costs the least.',
];

const followUps = [
  'Why?', 'And then?', 'What about payments?', 'Which one?', 'More details', 'How so?',
  'Can I do that?', 'What if it fails?', 'The second one', 'How much?', 'Is it available?',
  'And the cost?', 'What about that?', 'Explain more', 'Why not?',
];

const mixedMessages = [
  'Mero order ko status k xa?',
  'Website ko naam k ho?',
  'Business ko rating kati xa?',
  'Aile website chalirako xa?',
  'Mero payment ko status k xa?',
  'Yo booking kasari garne?',
  'Mero account ko details k xa?',
  'Order ko delivery kaha pugyo?',
  'Service ko price kati ho?',
  'Yo login kina hudaina?',
  'Reviews kati ota xa?',
  'Payment kasari garne please?',
];

describe('100-message local NLU evaluation', () => {
  test('corrects known English typos without changing unrelated text', () => {
    for (const [wrong, right] of typoWords) {
      const input = `Can you explain the ${wrong} details?`;
      assert.equal(understandingText(input).interpreted, `Can you explain the ${right} details?`, input);
    }
    assert.equal(typoWords.length, 38);
  });

  test('maps the explicit Romanized Nepali and Devanagari evaluation phrases', () => {
    for (const [input, expected] of romanizedNepali) assert.equal(understandingText(input).interpreted, expected, input);
    for (const [input, expected] of devanagariNepali) assert.equal(understandingText(input).interpreted, expected, input);
  });

  test('preserves clear English and resolves incomplete follow-up forms', () => {
    for (const input of englishMessages) {
      assert.equal(understandingText(input).interpreted, input, input);
      assert.equal(detectInputLanguage(input), 'English', input);
    }
    const history = [{ question: 'How do I register?', answer: 'Open the registration page.' }];
    for (const input of followUps) assert.equal(isFollowUp(input, history), true, input);
  });

  test('recognizes mixed Nepali-English and keeps the original message', () => {
    for (const input of mixedMessages) {
      const result = understandingText(input);
      assert.match(result.language, /Romanized|mixed/i, input);
      assert.equal(result.original, input);
    }
  });

  test('uses the same interpretation for clock and small-talk fast paths', () => {
    assert.equal(isClockQuestion('wat time is it?'), true);
    assert.equal(understandingText('aile nepal ma kati bajyo').interpreted, 'what is the current time in Nepal');
    assert.equal(asksCurrent('aile service chalirako xa'), true);
    assert.equal(smallTalkKind('thx'), 'thanks');
    assert.equal(smallTalkKind('ali simple language ma vana'), null);
  });
});

describe('bounded conversation history', () => {
  test('keeps recent complete context and accounts for standalone interpretations', () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      question: `Question ${i} `.padEnd(500, 'q'),
      answer: `Answer ${i} `.padEnd(700, 'a'),
      standalone: `Resolved topic ${i} `.padEnd(200, 's'),
    }));
    const window = historyWindow(turns);
    assert.ok(window.length < turns.length);
    assert.equal(window.at(-1).question.slice(0, 10), 'Question 9');
    assert.ok(window.every((turn) => turn.standalone?.length <= 800));
    const used = window.reduce((sum, turn) => sum + turn.question.length + turn.answer.length + turn.standalone.length, 0);
    assert.ok(used <= 12000);
  });
});

test('evaluation fixture covers exactly 100 varied user messages', () => {
  assert.equal(typoWords.length + romanizedNepali.length + devanagariNepali.length + englishMessages.length + followUps.length + mixedMessages.length, 100);
});
