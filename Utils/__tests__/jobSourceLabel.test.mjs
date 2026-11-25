// The "Source" line on Discord job alerts. Each case mirrors how a real write
// path stores the card (AddJob for clients and operators, JobApiScrape for the
// API importers, the jr-direct extension through AddJob).

import assert from 'node:assert/strict';
import test from 'node:test';

import { jobSourceLabel } from '../jobSourceLabel.js';

const nullDecision = { reason: null, score: null };

test('an API import names the API', () => {
  assert.equal(jobSourceLabel({ importSource: 'adzuna-api', createdByRole: 'operations', addedBy: 'operations', aiDecision: { reason: 'fits' } }), 'Adzuna API');
  assert.equal(jobSourceLabel({ importSource: 'hiringcafe-scrape', addedBy: 'Shubhangi' }), 'hiring.cafe (added by Shubhangi)');
});

test('an extension push that reports its board names the board', () => {
  assert.equal(jobSourceLabel({ importSource: 'seek', addedBy: 'Sonali', extensionCode: '12345' }), 'Seek (added by Sonali)');
  assert.equal(jobSourceLabel({ importSource: 'JobRight' }), 'JobRight');
});

test('an unknown importSource is shown as stored', () => {
  assert.equal(jobSourceLabel({ importSource: 'newboard' }), 'newboard');
});

test('a client add says so, even with an empty aiDecision object', () => {
  assert.equal(jobSourceLabel({ createdByRole: 'user', operatorEmail: 'user@flashfirehq', operatorName: 'user', aiDecision: nullDecision }), 'Added by the client');
  assert.equal(jobSourceLabel({ operatorEmail: 'user@flashfirehq' }), 'Added by the client');
});

test('an extension push without a board is labelled as such', () => {
  assert.equal(
    jobSourceLabel({ createdByRole: 'operations', addedBy: 'Sonali', extensionCode: '12345', aiDecision: nullDecision }),
    'Extension, site not recorded (pushed by Sonali)'
  );
  assert.equal(jobSourceLabel({ createdByRole: 'operations', aiDecision: { reason: 'Strong match' } }), 'Extension, site not recorded');
});

test('an operator adding by hand is named; nothing known says so', () => {
  assert.equal(jobSourceLabel({ createdByRole: 'operations', addedBy: 'Shubhangi', aiDecision: nullDecision }), 'Added by Shubhangi');
  assert.equal(jobSourceLabel({ createdByRole: 'operations', addedBy: 'operations' }), 'Not recorded');
  assert.equal(jobSourceLabel({}), 'Not recorded');
  assert.equal(jobSourceLabel(null), 'Unknown');
});

// The useful-mail Discord line carries the matched card and its source.
test('the useful-mail line shows Job and Source when a card matched, and says so when none did', async () => {
  process.env.ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS = 'https://discord.example.test/webhook';
  const { notifyUsefulMailLine } = await import('../discordMailNotify.js');
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  try {
    await notifyUsefulMailLine({
      clientName: 'Asha', category: 'interview', subject: 'Interview invite', from: 'jobs@acme.com', receivedAt: new Date(),
      job: { jobTitle: 'Data Analyst', companyName: 'Acme', source: 'Seek (added by Sonali)' },
    });
    await notifyUsefulMailLine({ clientName: 'Asha', category: 'offer', subject: 'Offer', from: 'hr@acme.com' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent[0].url, 'https://discord.example.test/webhook');
  const f1 = Object.fromEntries(sent[0].body.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(f1.Job, 'Data Analyst at Acme');
  assert.equal(f1.Source, 'Seek (added by Sonali)');
  const f2 = Object.fromEntries(sent[1].body.embeds[0].fields.map((f) => [f.name, f.value]));
  assert.equal(f2.Job, undefined);
  assert.equal(f2.Source, 'Unknown (no matching job card)');
});
