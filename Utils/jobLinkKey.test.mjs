// node Utils/jobLinkKey.test.mjs
//
// The two failure modes this has to balance:
//   TOO LOOSE  -> the same posting slips in five times (the reported bug)
//   TOO TIGHT  -> two different postings collapse to one key and the second is
//                 rejected as a duplicate, silently losing a real job
// The second is worse, so the "must NOT collide" block is the important half.
import { jobLinkKey } from './jobLinkKey.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got  ${got}\n        want ${want}`);
};
const same = (name, a, b) => {
  const ka = jobLinkKey(a), kb = jobLinkKey(b);
  const ok = ka === kb && ka !== '';
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        ${a}\n          -> ${ka}\n        ${b}\n          -> ${kb}`);
};
const diff = (name, a, b) => {
  const ka = jobLinkKey(a), kb = jobLinkKey(b);
  const ok = ka !== kb;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        both collapsed to: ${ka}`);
};

console.log('--- the reported case ---');
t('tally.so link', jobLinkKey('https://tally.so/r/686AMB'), 'tally.so/r/686AMB');
same('same tally link twice', 'https://tally.so/r/686AMB', 'https://tally.so/r/686AMB');

console.log('\n--- MUST collide (same posting, cosmetic differences) ---');
same('trailing slash',     'https://tally.so/r/686AMB',  'https://tally.so/r/686AMB/');
same('www prefix',         'https://www.tally.so/r/686AMB', 'https://tally.so/r/686AMB');
same('scheme',             'http://tally.so/r/686AMB',   'https://tally.so/r/686AMB');
same('host case',          'https://TALLY.SO/r/686AMB',  'https://tally.so/r/686AMB');
same('utm params',         'https://tally.so/r/686AMB?utm_source=linkedin&utm_medium=cpc', 'https://tally.so/r/686AMB');
same('fragment',           'https://tally.so/r/686AMB#apply', 'https://tally.so/r/686AMB');
same('gh_src is a SOURCE', 'https://boards.greenhouse.io/acme/jobs/4?gh_src=abc', 'https://boards.greenhouse.io/acme/jobs/4');
same('param order',        'https://acme.com/j?b=2&a=1', 'https://acme.com/j?a=1&b=2');
same('no scheme pasted',   'careers.acme.com/jobs/12',   'https://careers.acme.com/jobs/12');
same('fbclid + gclid',     'https://acme.com/j/9?fbclid=x&gclid=y', 'https://acme.com/j/9');
same('whitespace',         '  https://tally.so/r/686AMB  ', 'https://tally.so/r/686AMB');

console.log('\n--- MUST NOT collide (different postings) ---');
diff('different tally form',  'https://tally.so/r/686AMB', 'https://tally.so/r/999XYZ');
diff('gh_jid is the JOB ID',  'https://acme.com/apply?gh_jid=111', 'https://acme.com/apply?gh_jid=222');
diff('jobId param',           'https://acme.com/careers?jobId=1', 'https://acme.com/careers?jobId=2');
diff('requisitionId',         'https://wd5.myworkdayjobs.com/x?requisitionId=A', 'https://wd5.myworkdayjobs.com/x?requisitionId=B');
diff('different path',        'https://acme.com/jobs/1', 'https://acme.com/jobs/2');
diff('different host',        'https://acme.com/jobs/1', 'https://beta.com/jobs/1');
diff('path CASE is kept',     'https://acme.com/Jobs/AB', 'https://acme.com/jobs/ab');
diff('subdomain matters',     'https://careers.acme.com/j/1', 'https://jobs.acme.com/j/1');

console.log('\n--- no identity: must return "" so the check is SKIPPED ---');
// If these returned a key, every job with a blank link would look like a
// duplicate of every other one and adding would break completely.
for (const v of ['', '   ', null, undefined, 'www.google.com', 'https://www.google.com/',
                 'google.com', 'N/A', 'n/a', 'none', 'null', 'undefined', '-', 'example.com']) {
  t(`placeholder ${JSON.stringify(v)}`, jobLinkKey(v), '');
}
// mailto: has a scheme but no "//". Prepending https:// to it parses the
// address as userinfo and hands back the company host, so a mailto link would
// have been keyed as that company's careers page.
t('non-http scheme (mailto)', jobLinkKey('mailto:jobs@acme.com'), '');
t('non-http scheme (ftp)',    jobLinkKey('ftp://acme.com/jobs'), '');
t('non-http scheme (js)',     jobLinkKey('javascript:alert(1)'), '');
t('non-http scheme (data)',   jobLinkKey('data:text/html,x'), '');
// A colon followed by digits is a PORT, not a scheme, and must still parse.
t('host with a port', jobLinkKey('acme.com:8080/jobs/1'), 'acme.com:8080/jobs/1');
// Credentials never identify a posting and must not leak into the key.
same('userinfo ignored', 'https://user:pw@acme.com/j/1', 'https://acme.com/j/1');

console.log('\n--- unparseable input still self-matches ---');
same('garbage text', 'not a url at all', 'not a url at all');
t('garbage squashed', jobLinkKey('Not A URL At All'), 'notaurlatall');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
