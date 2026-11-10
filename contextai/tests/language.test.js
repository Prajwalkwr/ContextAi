import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ensureEnglishAnswer, responseLanguage } from '../apps/api/src/assistant/language.js';
import { llm } from '../apps/api/src/lib/llm.js';

after(() => llm.setClientForTesting(null));

test('language identification ignores code, direct quotations and short ambiguous text', () => {
  return Promise.all([
    responseLanguage('This is a clear English answer with enough words to identify it accurately, while reducing accidental language detection errors on short replies.'),
    responseLanguage('नमस्ते, यो व्यवसाय राम्रो छ। यसमा सम्भावना पनि छ।'),
    responseLanguage('```js\nconst greeting = \"नमस्ते\";\n```'),
    responseLanguage('Hello there.'),
  ]).then(([english, nepali, code, short]) => {
    assert.equal(english, 'en');
    assert.equal(nepali, 'non-english-script');
    assert.equal(code, 'und');
    assert.equal(short, 'und');
  });
});

test('non-English generated prose is rewritten and language-checked before delivery', async () => {
  const hindi = 'यह व्यवसाय अच्छा है और इसमें विकास की संभावना है। इसकी सफलता कीमत, उपलब्धता और ग्राहक सेवा पर निर्भर करेगी।';
  let called = false;
  llm.setClientForTesting({
    chat: {
      completions: {
        create: async (params) => {
          called = true;
          assert.equal(params.response_format.json_schema.name, 'english_answer');
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  answer: 'Hamro Kirana Pasal has growth potential. Its success will depend on pricing, reliable availability, and customer service. Clear product information and consistent stock can also help customers decide whether to return.',
                }),
              },
            }],
            usage: {},
          };
        },
      },
    },
  });

  const answer = await ensureEnglishAnswer({
    answer: hindi,
    question: 'kirana pasal ko barema vana',
    config: { projectName: 'UdyogConnect' },
    history: [],
  });
  assert.equal(called, true);
  assert.match(answer, /Hamro Kirana Pasal/);
  assert.equal(await responseLanguage(answer), 'en');
});

test('a failed English rewrite returns a safe English fallback', async () => {
  llm.setClientForTesting({
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify({ answer: 'यह उत्तर हिंदी में है और अंग्रेज़ी नहीं है।' }) } }],
          usage: {},
        }),
      },
    },
  });
  const answer = await ensureEnglishAnswer({ answer: 'यह हिंदी उत्तर बहुत अच्छा है और इसे समझना आसान है।', question: 'question' });
  assert.equal(answer, "I couldn't provide a reliable answer in English.");
});
