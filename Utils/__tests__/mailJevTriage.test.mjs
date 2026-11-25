// TypeSafe Jev as the mail second look: request shape, answer parsing,
// fallback to the chat model, and pricing. fetch is stubbed; nothing is sent.

import assert from 'node:assert/strict';
import test from 'node:test';

import { jevTriage, jevConfig, confidenceBand, JEV_CRITERIA, JEV_DEFAULT_URL } from '../../src/services/mailJevTriage.js';
import { triageMail } from '../../src/services/mailAiTriage.js';
import { normaliseUsage } from '../aiUsage.js';
import { rateFor, isUnpricedModel, priceTokens } from '../aiRateCard.js';

const ENV = { TYPESAFE_API_KEY: 'apikey_test' };
const mail = { from: 'Talent <no-reply@us.greenhouse-mail.io>', subject: 'Interview invitation - Data Analyst', bodyText: 'We would like to invite you to a video interview.' };

const jevReply = (choice, confidence, status = 200) => async (url, init) => {
  jevReply.calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
  if (status !== 200) return new Response('{"detail":"nope"}', { status });
  return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { category: { type: 'choice', choice, confidence, probabilities: {} } }, usage: { input_tokens: 524, output_tokens: 56 } }), { status: 200 });
};
jevReply.calls = [];

test('sends one choice question to /v1/systemone with a Bearer key', async () => {
  jevReply.calls = [];
  const r = await jevTriage(mail, { fetchImpl: jevReply('interview', 0.99), env: ENV });
  const { url, init } = jevReply.calls[0];
  assert.equal(url, JEV_DEFAULT_URL);
  assert.equal(init.headers.Authorization, 'Bearer apikey_test');
  assert.equal(init.body.model, 'jev-latest');
  assert.match(init.body.state, /^From: Talent .*\nSubject: Interview invitation/);
  assert.equal(init.body.questions.category.type, 'choice');
  assert.deepEqual(Object.keys(init.body.questions.category.criteria).sort(), ['assessment', 'interview', 'none', 'offer', 'rejection']);
  assert.deepEqual(r, { ok: true, category: 'interview', confidence: 'high', reason: 'jev: interview (0.99)', model: 'jev-1.14.0', error: '' });
});

test('confidence bands and unknown answers', async () => {
  assert.equal(confidenceBand(0.95), 'high');
  assert.equal(confidenceBand(0.7), 'medium');
  assert.equal(confidenceBand(0.4), 'low');
  assert.equal(confidenceBand(undefined), 'low');
  const r = await jevTriage(mail, { fetchImpl: jevReply('something-else', 0.9), env: ENV });
  assert.equal(r.category, 'none');
  assert.equal(Object.keys(JEV_CRITERIA).length, 5);
});

test('off without a key; URL and model can be overridden', async () => {
  assert.equal((await jevTriage(mail, { env: {} })).ok, false);
  assert.deepEqual(jevConfig({ TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-1.13.0', TYPESAFE_API_URL: 'https://x/v1/systemone' }), { apiKey: 'k', url: 'https://x/v1/systemone', model: 'jev-1.13.0' });
});

test('triageMail uses Jev when the key is set, and falls back to the chat model when Jev fails', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    if (url === JEV_DEFAULT_URL) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({ model: 'gpt-4o-mini', choices: [{ message: { content: '{"category":"assessment","confidence":"high","reason":"named test"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  };
  const r = await triageMail(mail, { fetchImpl, env: { ...ENV, OPENAI_API_KEY: 'sk-x' } });
  assert.deepEqual(seen, [JEV_DEFAULT_URL, 'https://api.openai.com/v1/chat/completions']);
  assert.equal(r.ok, true);
  assert.equal(r.category, 'assessment');

  const viaJev = await triageMail(mail, { fetchImpl: jevReply('rejection', 1), env: { ...ENV, OPENAI_API_KEY: 'sk-x' } });
  assert.equal(viaJev.model, 'jev-1.14.0');
  assert.equal(viaJev.category, 'rejection');
});

test('Jev usage is recorded and priced: $0.042 per 1M input, output free', () => {
  assert.deepEqual(normaliseUsage({ input_tokens: 524, output_tokens: 56 }), { inputTokens: 524, cachedTokens: 0, outputTokens: 56 });
  assert.equal(rateFor('jev-1.14.0').in, 0.042);
  assert.equal(rateFor('jev-1.14.0').out, 0);
  assert.equal(isUnpricedModel('jev-latest'), false);
  const p = priceTokens({ model: 'jev-1.14.0', inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(Math.abs(p.usd - 0.042) < 1e-9, String(p.usd));
});
