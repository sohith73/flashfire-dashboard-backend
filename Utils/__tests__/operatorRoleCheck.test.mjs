// The /updatechanges and /operations/jobs role check.
//
// 25 Nov 2026: the check looked operators up in UserModel, where they never
// are, so every operator edit and attachment upload in the portal returned 401
// "User not found or unauthorized". Operators live in Operations.

import assert from 'node:assert/strict';
import test from 'node:test';

import Operations from '../../Schema_Models/Operations.js';
import { UserModel } from '../../Schema_Models/UserModel.js';
import { getVerifiedUserRole } from '../../Controllers/UpdateChanges.js';

const OPERATORS = ['sohith@flashfirehq'];
const CLIENTS = ['shahiananyaa97@gmail.com'];

// Chainable stand-in for findOne(...).select().lean(), matching exact or /^..$/i.
const finder = (emails) => (q) => {
  const want = q.email;
  const hit = emails.find((e) => (want instanceof Object && want.$regex ? want.$regex.test(e) : e === want));
  const doc = hit ? { _id: hit } : null;
  return { select: () => ({ lean: () => Promise.resolve(doc) }) };
};
Operations.findOne = finder(OPERATORS);
UserModel.findOne = finder(CLIENTS);

test('an operator is verified against Operations, not the client collection', async () => {
  assert.equal(await getVerifiedUserRole({ operationsEmail: 'sohith@flashfirehq', userEmail: 'shahiananyaa97@gmail.com' }), 'operations');
  assert.equal(await getVerifiedUserRole({ operationsEmail: 'Sohith@FlashfireHQ', userEmail: 'x' }), 'operations', 'case-insensitive');
});

test('an unknown operator email is refused with 403', async () => {
  await assert.rejects(getVerifiedUserRole({ operationsEmail: 'nobody@flashfirehq', userEmail: 'shahiananyaa97@gmail.com' }), (e) => e.status === 403);
  await assert.rejects(getVerifiedUserRole({ operationsEmail: 'operations@flashfirehq', userEmail: 'shahiananyaa97@gmail.com' }), (e) => e.status === 403);
});

test('a client is verified against UserModel; a body role cannot promote them', async () => {
  assert.equal(await getVerifiedUserRole({ userEmail: 'shahiananyaa97@gmail.com' }), 'user');
  assert.equal(await getVerifiedUserRole({ operationsEmail: '', userEmail: 'shahiananyaa97@gmail.com' }), 'user');
  await assert.rejects(getVerifiedUserRole({ userEmail: 'ghost@example.com' }), (e) => e.status === 401);
});
