// autoLinkResume: matching rules and the decision tree, with a fake users
// model and a fake assign, so no Mongo and no network.

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ACTIVITY_INGEST_SECRET = 'test-secret';

const { autoLinkResume, default: handler } = await import('../../Controllers/Admin/AutoLinkResume.js');

function fakeUsers(rows) {
    const calls = [];
    return {
        calls,
        find(query) {
            const re = new RegExp(query.email.$regex, query.email.$options);
            const hits = rows.filter((r) => re.test(r.email));
            const chain = { select: () => chain, limit: (n) => { chain.n = n; return chain; }, lean: async () => hits.slice(0, chain.n ?? 99) };
            calls.push(query);
            return chain;
        },
    };
}

const assignOk = (log = []) => async (email, id, opts) => {
    log.push({ email, id, opts });
    return { outcome: 'assigned', user: { name: 'Asha K', email }, resumeIndexSynced: true };
};

test('exactly one match links, case and whitespace insensitive', async () => {
    const log = [];
    const r = await autoLinkResume(
        { email: '  Asha.K@Example.COM ', resumeId: 'r1' },
        { users: fakeUsers([{ email: 'asha.k@example.com', name: 'Asha K' }, { email: 'other@example.com' }]), assign: assignOk(log) },
    );
    assert.equal(r.status, 'linked');
    assert.equal(r.name, 'Asha K');
    assert.deepEqual(log, [{ email: 'asha.k@example.com', id: 'r1', opts: { onlyIfUnassigned: true } }]);
});

test('stored email with mixed case and padding still matches', async () => {
    const r = await autoLinkResume(
        { email: 'asha@example.com', resumeId: 'r1' },
        { users: fakeUsers([{ email: ' Asha@Example.com ', name: 'Asha' }]), assign: assignOk() },
    );
    assert.equal(r.status, 'linked');
});

test('regex characters in the address are matched literally', async () => {
    const r = await autoLinkResume(
        { email: 'a.b+c@example.com', resumeId: 'r1' },
        { users: fakeUsers([{ email: 'aXb+c@example.com' }]), assign: assignOk() },
    );
    assert.equal(r.status, 'no_match');
});

test('no match does nothing', async () => {
    const log = [];
    const r = await autoLinkResume({ email: 'x@y.co', resumeId: 'r1' }, { users: fakeUsers([]), assign: assignOk(log) });
    assert.equal(r.status, 'no_match');
    assert.equal(log.length, 0);
});

test('more than one client with the email is ambiguous and not linked', async () => {
    const log = [];
    const r = await autoLinkResume(
        { email: 'x@y.co', resumeId: 'r1' },
        { users: fakeUsers([{ email: 'x@y.co' }, { email: 'X@y.co' }]), assign: assignOk(log) },
    );
    assert.equal(r.status, 'ambiguous');
    assert.equal(log.length, 0);
});

test('a client who already has a resume is never overwritten', async () => {
    const log = [];
    const r = await autoLinkResume(
        { email: 'x@y.co', resumeId: 'r2' },
        { users: fakeUsers([{ email: 'x@y.co', name: 'X', assignedResumeId: 'r1' }]), assign: assignOk(log) },
    );
    assert.equal(r.status, 'already_linked');
    assert.equal(log.length, 0);
});

test('losing the atomic claim reports already_linked', async () => {
    const r = await autoLinkResume(
        { email: 'x@y.co', resumeId: 'r2' },
        { users: fakeUsers([{ email: 'x@y.co', name: 'X' }]), assign: async () => ({ outcome: 'already_assigned' }) },
    );
    assert.equal(r.status, 'already_linked');
});

test('garbage email is rejected without a query', async () => {
    const users = fakeUsers([]);
    for (const email of ['', '   ', 'not-an-email', null]) {
        const r = await autoLinkResume({ email, resumeId: 'r1' }, { users, assign: assignOk() });
        assert.equal(r.status, 'invalid_email');
    }
    assert.equal(users.calls.length, 0);
});

function run(headers, body) {
    return new Promise((resolve) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, body: b }); } };
        handler({ headers, body }, res);
    });
}

test('endpoint needs the shared secret', async () => {
    assert.equal((await run({}, { email: 'a@b.co', resumeId: 'r' })).code, 401);
    assert.equal((await run({ 'x-activity-secret': 'wrong' }, { email: 'a@b.co', resumeId: 'r' })).code, 401);
    assert.equal((await run({ 'x-activity-secret': 'test-secret' }, { email: 'a@b.co' })).code, 400);
});
