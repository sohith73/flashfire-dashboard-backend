// Jev watch: the per-client Discord card that shows what the AI second look
// decided for each new mail. Pure builders are tested directly; the toggle
// lookup stubs ClientReminderConfig.findOne; nothing is posted.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import ClientReminderConfig, { mergeWithDefaults } from '../../Schema_Models/ClientReminderConfig.js';
import {
  isJevWatchOn,
  jevWatchRow,
  jevWatchTotals,
  buildJevWatchEmbed,
  triageEngine,
} from '../../src/services/mailJevWatch.js';
import { jevWatchWebhook } from '../discordMailNotify.js';
import {
  judgeDigest,
  isFinding,
  buildBackfillMessages,
  runJevBackfill,
  isBackfillRunning,
  backfillLimit,
  embedSize,
} from '../../src/services/mailJevBackfill.js';

const jevFound = jevWatchRow({
  digest: {
    subject: 'Interview invitation: Product Manager at Acme',
    fromEmail: 'no-reply@greenhouse.io',
    rulesCategory: 'other',
    category: 'interview',
    aiTriageRan: true,
    aiTriageCategory: 'interview',
    aiTriageReason: 'jev: interview (0.93)',
    aiTriageFound: true,
    verifyRan: true,
    verifyGenuine: true,
  },
  triageModel: 'jev-1.14.0',
  clientNotify: 'sent',
});
const jevNone = jevWatchRow({
  digest: {
    subject: 'Thanks for applying',
    fromEmail: 'jobs@acme.com',
    rulesCategory: 'other',
    category: 'other',
    aiTriageRan: true,
    aiTriageCategory: 'none',
    aiTriageReason: 'jev: none (0.88)',
  },
  triageModel: 'jev-1.14.0',
  clientNotify: 'skipped',
});
const skipped = jevWatchRow({
  digest: { subject: '50% off this week', fromEmail: 'deals@shop.com', rulesCategory: 'promo', category: 'promo', aiTriageSkipped: 'marketing-sender' },
});
const fallback = jevWatchRow({
  digest: { subject: 'Next steps', fromEmail: 'hr@x.com', rulesCategory: 'other', category: 'other', aiTriageRan: true, aiTriageCategory: 'none' },
  triageModel: 'gpt-4o-mini',
});
const failed = jevWatchRow({
  digest: { subject: 'Hello', fromEmail: 'a@b.com', rulesCategory: 'other', category: 'other', aiTriageRan: false, aiTriageError: 'Jev timeout | fallback: no key' },
});
const rejected = jevWatchRow({
  digest: { subject: 'Your application', fromEmail: 'careers@bank.com', rulesCategory: 'rejection', category: 'rejection', verifyRan: true, verifyGenuine: true },
  autoReject: 'applied',
});

test('triageEngine tells Jev from the chat fallback', () => {
  assert.equal(triageEngine('jev-1.14.0'), 'jev');
  assert.equal(triageEngine('jev-latest'), 'jev');
  assert.equal(triageEngine('gpt-4o-mini-2024-07-18'), 'fallback');
  assert.equal(triageEngine(''), 'fallback');
});

test('rows classify each triage outcome', () => {
  assert.deepEqual(jevFound.triage, { kind: 'ran', engine: 'jev', category: 'interview', reason: 'jev: interview (0.93)', found: true });
  assert.equal(skipped.triage.kind, 'skipped');
  assert.equal(fallback.triage.engine, 'fallback');
  assert.equal(failed.triage.kind, 'error');
  assert.equal(rejected.triage.kind, 'rules'); // regexes flagged it, no AI read
  assert.equal(jevFound.verifyGenuine, true);
  assert.equal(jevNone.verifyGenuine, null); // verifier never ran
});

test('totals count Jev reads, finds, skips, fallbacks, errors and actions', () => {
  const t = jevWatchTotals([jevFound, jevNone, skipped, fallback, failed, rejected]);
  assert.deepEqual(t, { mails: 6, jev: 2, found: 1, fallback: 1, skipped: 1, errors: 1, alerted: 1, autoRejected: 1 });
});

test('embed lists every mail with Jev pick, score and outcome', () => {
  const e = buildJevWatchEmbed({
    client: { name: 'Rijul Jain', email: 'rijul@example.com' },
    mailbox: 'rijul@example.com',
    rows: [jevFound, jevNone, skipped, fallback, failed, rejected],
    now: new Date('2026-11-25T10:00:00Z'),
  });
  assert.equal(e.title, '🔎 Jev watch: Rijul Jain');
  assert.match(e.description, /Interview invitation: Product Manager at Acme/);
  assert.match(e.description, /Jev: \*\*interview\*\* 0\.93/);
  assert.match(e.description, /→ \*\*interview\*\*/); // regex said other, final is interview
  assert.match(e.description, /verified real · client alerted/);
  assert.match(e.description, /Jev: \*\*none\*\* 0\.88/);
  assert.match(e.description, /skipped \(marketing-sender\)/);
  assert.match(e.description, /fallback model \(Jev failed\)/);
  assert.match(e.description, /AI failed: Jev timeout/);
  assert.match(e.description, /card moved to Rejected/);
  assert.equal(e.color, 0x22c55e);
  assert.equal(e.fields.find((f) => f.name === 'Read by Jev').value, '2');
  assert.equal(e.timestamp, '2026-11-25T10:00:00.000Z');
});

test('embed stays inside Discord limits and escapes markdown', () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    jevWatchRow({ digest: { subject: `**bold** \`code\` mail ${i} ${'x'.repeat(150)}`, fromEmail: 'a@b.com', rulesCategory: 'other', category: 'other', aiTriageRan: true, aiTriageCategory: 'none', aiTriageReason: 'jev: none (0.9)' }, triageModel: 'jev-1.14.0' })
  );
  const e = buildJevWatchEmbed({ client: {}, mailbox: 'm@x.com', rows: many });
  assert.ok(e.description.length <= 4096, `description ${e.description.length}`);
  assert.ok(embedSize(e) <= 6000, 'one live card must fit one Discord message');
  assert.match(e.description, /…and \d+ more$/);
  assert.ok(!e.description.includes('**bold**'));
  assert.match(e.description, /\\\*\\\*bold\\\*\\\*/);
  assert.equal(e.title, '🔎 Jev watch: m@x.com');
});

test('quiet poll is grey, failures are orange', () => {
  assert.equal(buildJevWatchEmbed({ rows: [jevNone, skipped] }).color, 0x64748b);
  assert.equal(buildJevWatchEmbed({ rows: [jevNone, failed] }).color, 0xf97316);
});

test('isJevWatchOn reads the strict per-client toggle and fails closed', async (t) => {
  const seen = [];
  t.mock.method(ClientReminderConfig, 'findOne', (q) => {
    seen.push(q);
    return { select: () => ({ lean: async () => (q.clientEmail === 'on@x.com' ? { _id: 1 } : null) }) };
  });
  assert.equal(await isJevWatchOn('ON@x.com '), true);
  assert.equal(await isJevWatchOn('off@x.com'), false);
  assert.equal(await isJevWatchOn(''), false);
  assert.deepEqual(seen[0], { clientEmail: 'on@x.com', jevWatchEnabled: true });

  t.mock.method(ClientReminderConfig, 'findOne', () => {
    throw new Error('db down');
  });
  assert.equal(await isJevWatchOn('on@x.com'), false);
});

test('config API exposes jevWatchEnabled, off unless exactly true', () => {
  assert.equal(mergeWithDefaults({ clientEmail: 'a@b.com' }).jevWatchEnabled, false);
  assert.equal(mergeWithDefaults({ clientEmail: 'a@b.com', jevWatchEnabled: 'true' }).jevWatchEnabled, false);
  assert.equal(mergeWithDefaults({ clientEmail: 'a@b.com', jevWatchEnabled: true }).jevWatchEnabled, true);
  const ctrl = fs.readFileSync(new URL('../../Controllers/operations/ClientReminders.js', import.meta.url), 'utf8');
  assert.match(ctrl, /set\.jevWatchEnabled = jevWatchEnabled === true/);
});

test('webhook: MAIL_JEV_WATCH_WEBHOOK overrides the mail channel', () => {
  assert.equal(jevWatchWebhook({ MAIL_JEV_WATCH_WEBHOOK: 'https://discord.test/hook' }), 'https://discord.test/hook');
  assert.match(jevWatchWebhook({}), /^https:\/\/discord\.com\/api\/webhooks\//);
});

test('poll worker builds a row per saved digest and posts once after the loop', () => {
  const src = fs.readFileSync(new URL('../../src/services/mailPollWorker.js', import.meta.url), 'utf8');
  assert.match(src, /const jevWatch = fresh\.length && \(await isJevWatchOn\(ownerEmail\)\) \? \[\] : null;/);
  assert.match(src, /jevWatch\?\.push\(jevWatchRow\(\{ digest: digestDoc, triageModel, autoReject: rej\?\.outcome, clientNotify \}\)\)/);
  const post = src.indexOf('await postJevWatch(');
  assert.ok(post > src.indexOf('for (const messageId of fresh)') && post < src.indexOf('lastInternalDate: maxInternalDate'));
});

// ── Backfill: Jev over the client's previous mails ─────────────────────

const jev = (category, p = 0.9) => async () => ({ ok: true, category, confidence: p >= 0.8 ? 'high' : p >= 0.6 ? 'medium' : 'low', reason: `jev: ${category} (${p})`, model: 'jev-1.14.0', error: '' });
const old = (o) => ({ subject: 'Update on your application', fromEmail: 'hr@acme.com', from: 'Acme HR <hr@acme.com>', snippet: 'Hi Rijul, thanks for your time', date: new Date('2026-11-10T10:00:00Z'), category: 'other', rulesCategory: 'other', ...o });

test('backfillLimit clamps to 1..1000, default 500', () => {
  assert.equal(backfillLimit(undefined), 500);
  assert.equal(backfillLimit('abc'), 500);
  assert.equal(backfillLimit(-3), 500);
  assert.equal(backfillLimit(50), 50);
  assert.equal(backfillLimit(99999), 1000);
});

test('judgeDigest skips marketing and reads everything else, regex-flagged too', async () => {
  let calls = 0;
  const counted = async (m) => { calls++; return jev('interview')(m); };
  const r1 = await judgeDigest(old({ category: 'rejection', rulesCategory: 'rejection' }), { triage: counted });
  assert.equal(r1.kind, 'ran'); // regex flagged it; the backfill still checks it
  assert.equal(r1.recorded, 'rejection');
  const r1b = await judgeDigest(old({ category: 'interview', rulesCategory: 'interview', verifyRan: true, verifyGenuine: false }), { triage: counted });
  assert.equal(r1b.recorded, 'other'); // verifier threw it out
  const r2 = await judgeDigest(old({ subject: '50% off all courses this weekend', fromEmail: 'deals@udemy.com', from: 'Udemy <deals@udemy.com>', snippet: 'Sale ends Sunday', category: 'promo', rulesCategory: 'promo' }), { triage: counted });
  assert.equal(r2.kind, 'skipped');
  const r3 = await judgeDigest(old({}), { triage: counted });
  assert.equal(r3.kind, 'ran');
  assert.equal(r3.category, 'interview');
  assert.equal(r3.found, true);
  assert.equal(r3.engine, 'jev');
  assert.equal(calls, 3);
  const r4 = await judgeDigest(old({}), { triage: async () => ({ ok: false, error: 'Jev HTTP 500' }) });
  assert.deepEqual([r4.kind, r4.why], ['error', 'Jev HTTP 500']);
});

test('findings are disagreements and failures, not agreement', () => {
  const base = { kind: 'ran', engine: 'jev' };
  assert.equal(isFinding({ ...base, recorded: 'other', category: 'interview', found: true }), true); // Jev found a miss
  assert.equal(isFinding({ ...base, recorded: 'interview', category: 'none', found: false }), true); // pipeline flagged, Jev disagrees
  assert.equal(isFinding({ ...base, recorded: 'rejection', category: 'none', found: false, verified: true }), false); // full-body verifier outranks a preview read
  assert.equal(isFinding({ ...base, recorded: 'interview', category: 'interview', found: true }), false);
  assert.equal(isFinding({ ...base, recorded: 'other', category: 'none', found: false }), false);
  assert.equal(isFinding({ ...base, recorded: 'other', category: 'interview', found: false }), false); // low confidence
  assert.equal(isFinding({ kind: 'error' }), true);
  assert.equal(isFinding({ kind: 'skipped' }), false);
});

test('backfill messages: summary first, findings packed, Discord limits kept', () => {
  const results = [
    { kind: 'ran', engine: 'jev', recorded: 'other', category: 'interview', found: true, reason: 'jev: interview (0.95)', subject: 'Interview with Acme', from: 'hr@acme.com', date: '2026-11-10T00:00:00Z' },
    { kind: 'ran', engine: 'jev', recorded: 'other', category: 'none', found: false, reason: 'jev: none (0.9)', subject: 'Thanks', from: 'a@b.com', date: '2026-11-12T00:00:00Z' },
    { kind: 'skipped', why: 'marketing-sender', subject: 'Sale', from: 'x@y.com', date: '2026-11-11T00:00:00Z', recorded: 'promo' },
  ];
  const msgs = buildBackfillMessages({ client: { name: 'Rijul Jain' }, clientEmail: 'r@x.com', results, requestedBy: 'Sohith' });
  assert.equal(msgs.length, 1);
  const [summary, findings] = msgs[0];
  assert.equal(summary.title, '🔎 Jev on previous mails: Rijul Jain');
  assert.match(summary.description, /re-read 3 stored mails \(2026-11-10 to 2026-11-12\)/);
  assert.match(summary.description, /Read-only/);
  assert.match(summary.footer.text, /run by Sohith/);
  assert.equal(summary.fields.find((f) => f.name === 'Jev found').value, '1');
  assert.equal(summary.fields.find((f) => f.name === 'Agrees').value, '1');
  assert.match(findings.description, /🟢 Interview with Acme/);
  assert.match(findings.description, /recorded: \*\*other\*\* · Jev: \*\*interview\*\* 0\.95/);

  const many = Array.from({ length: 2000 }, (_, i) => ({ kind: 'error', why: 'x'.repeat(100), subject: `s${i} ${'y'.repeat(80)}`, from: 'a@b.com', date: '2026-11-01' }));
  const big = buildBackfillMessages({ clientEmail: 'r@x.com', results: many });
  assert.ok(big.length <= 3);
  for (const m of big) {
    assert.ok(m.length <= 10);
    for (const e of m) assert.ok((e.description || '').length <= 4096);
    assert.ok(m.reduce((n, e) => n + embedSize(e), 0) <= 6000, 'Discord rejects a message over 6000 chars');
  }
  assert.match(big.at(-1).at(-1).description, /more not shown$/);
});

test('runJevBackfill reads, posts, and holds a per-client lock', async () => {
  const posted = [];
  const digests = [old({}), old({ subject: 'Your interview is confirmed', category: 'interview', rulesCategory: 'interview' })];
  const p = runJevBackfill(
    { clientEmail: 'Lock@X.com', client: { name: 'L' }, limit: 10, requestedBy: 'ops' },
    { triage: jev('none'), post: async (e) => { posted.push(e); return { ok: true }; }, findDigests: async (email, limit) => { assert.deepEqual([email, limit], ['lock@x.com', 10]); return digests; } }
  );
  assert.equal(isBackfillRunning('lock@x.com'), true);
  const again = await runJevBackfill({ clientEmail: 'lock@x.com' }, { findDigests: async () => [] });
  assert.equal(again.error, 'already_running');
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.totals.mails, 2);
  assert.equal(r.totals.jev, 2);
  assert.equal(r.totals.findings, 1); // regex said interview, Jev says none
  assert.equal(posted.length, 1);
  assert.equal(isBackfillRunning('lock@x.com'), false);
});

test('backfill endpoint is wired behind the ops key and answers 202', () => {
  const routes = fs.readFileSync(new URL('../../Routes.js', import.meta.url), 'utf8');
  assert.match(routes, /app\.post\('\/operations\/reminders\/jev-backfill', requireOpsKey, runClientJevBackfill\)/);
  const ctrl = fs.readFileSync(new URL('../../Controllers/operations/ClientReminders.js', import.meta.url), 'utf8');
  assert.match(ctrl, /status\(409\)/);
  assert.match(ctrl, /status\(202\)/);
});
