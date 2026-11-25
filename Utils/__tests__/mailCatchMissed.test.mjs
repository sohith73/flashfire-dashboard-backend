// Mail that was being missed (Nov 2026 audit of live mail), the marketing
// filter in front of the AI second look, the configurable mail AI provider,
// and the daily cost card. Every phrasing below is taken from a real mail the
// pipeline dropped; names and companies are kept because they are what the
// patterns key on, client names are not.

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyMailByRules, normalizeMailText, hasMilestoneSubject } from '../mailRulesClassifier.js';
import { triageSkipReason } from '../mailPromoFilter.js';
import { mailAiConfig, OPENAI_CHAT_URL } from '../mailAiConfig.js';
import { rateFor, envRateFor, isUnpricedModel } from '../aiRateCard.js';
import { buildMailAiCostEmbed, previousIstDay } from '../mailAiCostEmbed.js';

const cat = (from, subject, body = '') => classifyMailByRules({ from, subject, bodyText: body, snippet: '' }).category;

// ── normalisation: the main reason regexes missed real mail ──────────────

test('wrapped lines, &nbsp;, entities and curly apostrophes no longer break a phrase', () => {
  assert.equal(normalizeMailText('After careful\r\nconsideration,&nbsp;we’re &#39;ok&#39; &rsquo;‎'), "After careful consideration, we're 'ok' '");
  // Each of these used to fall through to "job-application".
  assert.equal(cat('jobs@acme.com', 'Your application', 'Dear A,\nAfter careful\nconsideration, we have decided to pursue other applicants.'), 'rejection');
  assert.equal(cat('jobs@acme.com', 'Update', 'Thank you.&nbsp;Unfortunately,&nbsp;we will not be moving forward.'), 'rejection');
  assert.equal(cat('jobs@acme.com', 'Update', 'We’re pleased to extend you an offer for the role.'), 'offer');
});

// ── rejections the regexes missed ────────────────────────────────────────

test('rejection phrasings from the missed mails are caught', () => {
  for (const body of [
    'After review, we have decided to not move forward at this time.',
    'After careful review, a decision has been made to not move forward with your application.',
    'At this time you are not being considered further for the following role: Test Engineering.',
    'We do not feel that this job is the right match for your background.',
    'Based on the responses provided, you do not meet the required qualifications for this role.',
    'Your application has been unsuccessful as you have not met the eligibility requirements.',
    'After careful consideration, the difficult news to break is that we will not proceed.',
    'At this time we are considering other candidates whose experience more closely matches.',
    'Nous sommes au regret de vous informer que nous ne donnerons pas suite à votre candidature.',
  ]) assert.equal(cat('careers@employer.com', 'Your application', body), 'rejection', body);
});

// ── invites and assessments the regexes missed ───────────────────────────

test('calendar invites, screens and assessment platforms are flagged', () => {
  assert.equal(cat('calendar@akitahealth.com', 'Invitation from an unknown sender: Interview with Akita Health @ Mon Nov 23, 2026 9am', ''), 'interview');
  assert.equal(cat('x@volter-demo.teamtailor-mail.com', 'Time confirmed: Talent Screen with Volter', ''), 'interview');
  assert.equal(cat('x@volter-demo.teamtailor-mail.com', 'Meeting reminder', ''), 'interview');
  assert.equal(cat('hr@omnirms.com', 'National Highways Screening Call', ''), 'interview');
  assert.equal(cat('talent@ext.chime.com', 'Hi', "Let's get you scheduled to meet the team at Chime!"), 'interview');
  assert.equal(cat('noreply@cshr.tal.net', 'Reminder to complete the Civil Service Numerical Test - HEO Data Scientist', ''), 'assessment');
  assert.equal(cat('no-reply@email.roblox.com', '[Action Required] Your Roblox Assessments Invitation', ''), 'assessment');
  assert.equal(cat('no-reply@assessment.continental.com', 'Continental - Invitation to your Online Assessment', ''), 'assessment');
  assert.equal(cat('noreply@agileengine.com', 'Reminder: Complete your video introduction', ''), 'assessment');
  // "next step" in a subject reads as interview first; either way it reaches the verifier, which names the category.
  assert.ok(['interview', 'assessment'].includes(cat('noreply@criteriacorp.com', 'Your next step with Padlet', 'Please complete your CCAT.')));
  assert.equal(cat('noreply@mail.hirevue-app.eu', 'Shell', 'Hello'), 'assessment', 'an assessment platform sender is an assessment');
});

test('a rejection sent by an assessment platform is still a rejection', () => {
  assert.equal(cat('noreply@hirevue.com', 'Update', 'Unfortunately, we will not be moving forward with your application.'), 'rejection');
});

test("FlashFire's own notifications are filed first and never re-read", () => {
  assert.equal(cat('alerts@flashfirehq.com', 'You have an interview invite - NVIDIA - Virtual Interview', 'Unfortunately...'), 'flashfire-own');
  assert.equal(triageSkipReason({ from: 'Alerts <alerts@flashfirehq.com>', subject: 'You have an interview invite' }), 'flashfire-own-mail');
});

test('a subject that names a step is recognised (used to stop sender suppression)', () => {
  for (const s of ['Your Interview Invitation at Anchor', 'Pandora Assessment', 'Offer letter for Data Analyst', 'Reminder: Complete your interview for IDMe']) {
    assert.equal(hasMilestoneSubject(s), true, s);
  }
  assert.equal(hasMilestoneSubject('Thank you for applying to C3 AI'), false);
});

// ── marketing filter in front of the AI second look ──────────────────────

test('clear marketing skips the second look', () => {
  assert.equal(triageSkipReason({ from: 'jobs@jobright.ai', subject: '12 new jobs for you', rulesCategory: 'job-alert' }), 'marketing:job-alert');
  assert.equal(triageSkipReason({ from: 'digest@reddit.com', subject: 'Top posts this week', rulesCategory: 'newsletter' }), 'marketing:content-platform');
  assert.equal(triageSkipReason({ from: 'news@coursera.org', subject: 'Black Friday: 40% off', rulesCategory: 'other' }), 'marketing:sender');
  assert.equal(triageSkipReason({ from: 'team@saas.io', subject: 'Join our webinar on Thursday', rulesCategory: 'other' }), 'marketing:subject');
  assert.equal(triageSkipReason({ from: 'otp@otp.workday.com', subject: 'Your verification code', rulesCategory: 'account-security' }), 'account-security');
});

test('anything with a hiring word is always read, whoever sent it', () => {
  // The 2026-11-20 B&Q invite was filed as a job alert.
  assert.equal(triageSkipReason({ from: 'x@talent.icims.eu', subject: 'Interview invitation - B&Q', rulesCategory: 'job-alert' }), '');
  assert.equal(triageSkipReason({ from: 'jobs-noreply@linkedin.com', subject: 'New message', bodyText: 'Are you free for a phone screen on Monday?', rulesCategory: 'job-alert' }), '');
  assert.equal(triageSkipReason({ from: 'news@company.com', subject: 'Newsletter', bodyText: 'Unfortunately the role has been filled.', rulesCategory: 'newsletter' }), '');
  // A noreply ATS sender is filed as "newsletter" by the rules; it is still read.
  assert.equal(triageSkipReason({ from: 'no-reply@us.greenhouse-mail.io', subject: 'Important information about your C3 AI application', rulesCategory: 'newsletter' }), '');
  assert.equal(triageSkipReason({ from: 'noreply@msg.join.com', subject: 'Deine Bewerbung bei G-IN GmbH', rulesCategory: 'newsletter' }), '');
  assert.equal(triageSkipReason({ from: 'noreply@recrutement.covea.fr', subject: 'Suite de votre candidature au poste de Business Analyst', rulesCategory: 'job-alert' }), '');
  // Ordinary ATS and employer mail is never skipped.
  assert.equal(triageSkipReason({ from: 'noreply@myworkday.com', subject: 'Workday Notification Digest', rulesCategory: 'job-application' }), '');
  assert.equal(triageSkipReason({ from: 'recruiter@acme.com', subject: 'Quick question', rulesCategory: 'other' }), '');
});

// ── provider config ──────────────────────────────────────────────────────

test('a custom key is only ever sent to the custom URL', () => {
  const openai = mailAiConfig({ OPENAI_API_KEY: 'sk-a' });
  assert.deepEqual(openai, { url: OPENAI_CHAT_URL, apiKey: 'sk-a', model: 'gpt-4o-mini' });
  // Key without a URL: ignored, so it never reaches OpenAI.
  assert.equal(mailAiConfig({ OPENAI_API_KEY: 'sk-a', MAIL_AI_API_KEY: 'apikey_x' }).apiKey, 'sk-a');
  const custom = mailAiConfig({ OPENAI_API_KEY: 'sk-a', MAIL_AI_API_KEY: 'apikey_x', MAIL_AI_API_URL: 'https://llm.example/v1/chat/completions', MAIL_AI_MODEL: 'jev-1' });
  assert.deepEqual(custom, { url: 'https://llm.example/v1/chat/completions', apiKey: 'apikey_x', model: 'jev-1' });
  assert.equal(mailAiConfig({ MAIL_AI_MODEL: 'jev-1' }, { modelOverride: 'gpt-4o' }).model, 'gpt-4o');
});

// ── cost ─────────────────────────────────────────────────────────────────

test('the custom model is priced from env, and flagged when it is not', () => {
  const env = { MAIL_AI_MODEL: 'jev-1', MAIL_AI_RATE_IN: '0.05', MAIL_AI_RATE_OUT: '0.2' };
  assert.deepEqual(envRateFor('jev-1', env), { in: 0.05, cachedIn: 0.05, out: 0.2, asOf: 'env' });
  assert.equal(envRateFor('jev-1', { MAIL_AI_MODEL: 'jev-1' }), null, 'no price, no card');
  assert.equal(isUnpricedModel('some-unknown-model'), true);
  assert.equal(isUnpricedModel('gpt-4o-mini-2024-07-18'), false);
  assert.equal(rateFor('gpt-4o-mini').in, 0.15);
});

test('the daily cost card lists mail AI spend by model and step, and only mail sources', () => {
  const usage = { day: '2026-11-24', rows: [
    { source: 'mail-triage', model: 'some-new-model', calls: 900, callsMissingUsage: 0, inputTokens: 900000, outputTokens: 30000, usd: 0.06, inr: 5.64 },
    { source: 'mail-verify', model: 'gpt-4o-mini-2024-07-18', calls: 120, callsMissingUsage: 2, inputTokens: 300000, outputTokens: 9000, usd: 0.05, inr: 4.7 },
    { source: 'second-judge', model: 'gpt-4o-mini', calls: 5000, callsMissingUsage: 0, inputTokens: 1, outputTokens: 1, usd: 9, inr: 846 },
  ] };
  const e = buildMailAiCostEmbed(usage);
  assert.match(e.title, /2026-11-24/);
  const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
  assert.match(f.Total, /\$0\.1100 \(₹10\.34\) for 1,020 calls/);
  assert.match(f['By model'], /\*\*some-new-model\*\*: 900 calls/);
  assert.match(f['By model'], /some-new-model.*no price set/, 'an unpriced model is called out');
  assert.match(f['By step'], /Second look \(all non-marketing mail\): 900 calls/);
  assert.doesNotMatch(JSON.stringify(e), /second-judge/, 'job-judging spend is not mail spend');
  assert.match(f.Note, /2 call\(s\) returned no token count/);
  assert.match(buildMailAiCostEmbed({ day: 'd', rows: [] }).description, /No mail AI calls/);
  assert.match(buildMailAiCostEmbed(null, { error: 'mongo down' }).description, /mongo down/);
  assert.equal(previousIstDay(new Date('2026-11-25T00:00:00Z')), '2026-11-24');
});
