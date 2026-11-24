// Human-speed limit on a client's own writes, and the MCP off switch.
//
// The counter model is stubbed with an in-memory map that behaves like the
// upsert + $inc the middleware sends, so this runs without mongod. The real
// MongoDB path (TTL index, concurrent upserts) was run by hand against a local
// mongod; see the PR description.

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { signAuthToken, OPERATOR_VIEW } from '../AuthToken.js';
import HumanSpeedLimit, { HumanSpeedCounter, WINDOWS, clientSelf, recordWrite } from '../../Middlewares/HumanSpeedLimit.js';
import McpEnabled from '../../Middlewares/McpEnabled.js';

const store = new Map();
HumanSpeedCounter.findOneAndUpdate = async ({ _id }, update) => {
  const doc = store.get(_id) || { _id, n: 0, ...update.$setOnInsert };
  doc.n += update.$inc.n;
  store.set(_id, doc);
  return { ...doc };
};
beforeEach(() => store.clear());

const PER_MINUTE = WINDOWS.find((w) => w.key === 'm').max;
const client = 'Client@Example.com';
const clientToken = signAuthToken({ email: client });

function call(mw, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {}, body: null,
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; resolve({ next: false, res: this }); return this; },
    };
    Promise.resolve(mw({ method: 'PUT', path: '/updatechanges', headers: {}, ...req }, res, () => resolve({ next: true, res }))).catch(resolve);
  });
}

test('a client acting on their own account is counted', () => {
  assert.equal(clientSelf({ headers: {}, body: { token: clientToken, userDetails: { email: 'client@example.com' } } }), 'client@example.com');
  assert.equal(clientSelf({ headers: { authorization: `Bearer ${clientToken}` }, body: { email: client } }), 'client@example.com');
});

test('operators, operator views, extensions and bad tokens are never counted', () => {
  const opToken = signAuthToken({ email: 'ops@flashfire.com' });
  const viewToken = signAuthToken({ email: client, role: 'User', via: OPERATOR_VIEW });
  assert.equal(clientSelf({ headers: {}, body: { token: opToken, userDetails: { email: client } } }), null, 'operator token on a client');
  assert.equal(clientSelf({ headers: {}, body: { token: viewToken, userDetails: { email: client } } }), null, 'operator view');
  assert.equal(clientSelf({ headers: {}, body: { userDetails: { email: client }, role: 'operations' } }), null, 'extension push, no token');
  assert.equal(clientSelf({ headers: {}, body: { token: 'not-a-jwt', userDetails: { email: client } } }), null, 'bad token');
});

test(`the write after ${PER_MINUTE} in a minute gets a 429 with Retry-After`, async () => {
  const req = { body: { token: clientToken, userDetails: { email: client } } };
  for (let i = 0; i < PER_MINUTE; i++) {
    const { next } = await call(HumanSpeedLimit, req);
    assert.equal(next, true, `write ${i + 1} should pass`);
  }
  const { next, res } = await call(HumanSpeedLimit, req);
  assert.equal(next, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'TOO_FAST');
  assert.ok(Number(res.headers['Retry-After']) >= 1 && Number(res.headers['Retry-After']) <= 60);
});

test('the minute window resets, the hour window keeps counting', async () => {
  const t0 = Date.UTC(2026, 10, 24, 10, 0, 5);
  for (let i = 0; i < PER_MINUTE; i++) assert.equal(await recordWrite('a@x.com', t0), null);
  assert.equal((await recordWrite('a@x.com', t0)).window, 'minute');
  assert.equal(await recordWrite('a@x.com', t0 + 60_000), null, 'next minute is fresh');
  assert.equal(store.get(`a@x.com|h|${Date.UTC(2026, 10, 24, 10)}`).n, PER_MINUTE + 2);
});

test('one client being limited does not slow another', async () => {
  const req = { body: { token: clientToken, userDetails: { email: client } } };
  for (let i = 0; i <= PER_MINUTE; i++) await call(HumanSpeedLimit, req);
  const other = signAuthToken({ email: 'other@example.com' });
  const { next } = await call(HumanSpeedLimit, { body: { token: other, userDetails: { email: 'other@example.com' } } });
  assert.equal(next, true);
});

test('a counter outage lets the request through', async () => {
  const saved = HumanSpeedCounter.findOneAndUpdate;
  HumanSpeedCounter.findOneAndUpdate = async () => { throw new Error('db down'); };
  try {
    const { next } = await call(HumanSpeedLimit, { body: { token: clientToken, userDetails: { email: client } } });
    assert.equal(next, true);
  } finally {
    HumanSpeedCounter.findOneAndUpdate = saved;
  }
});

test('MCP routes answer 503 unless MCP_SERVER_ENABLED=true', async () => {
  const saved = process.env.MCP_SERVER_ENABLED;
  try {
    delete process.env.MCP_SERVER_ENABLED;
    let r = await call(McpEnabled, { path: '/mcp' });
    assert.equal(r.res.statusCode, 503);
    assert.equal(r.res.body.jsonrpc, '2.0');
    r = await call(McpEnabled, { path: '/mcp-keys' });
    assert.equal(r.res.statusCode, 503);
    assert.equal(r.res.body.code, 'MCP_DISABLED');
    process.env.MCP_SERVER_ENABLED = 'true';
    r = await call(McpEnabled, { path: '/mcp' });
    assert.equal(r.next, true);
  } finally {
    if (saved === undefined) delete process.env.MCP_SERVER_ENABLED; else process.env.MCP_SERVER_ENABLED = saved;
  }
});
