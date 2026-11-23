// FlashFire MCP server: keys, auth, scoping and the tool surface.
//
// No mongod in this repo's test run, so models are stubbed in place (the code
// under test imports the same module objects). The full flow against a real
// Mongo and the official MCP client was run by hand; see the PR description.

import test from "node:test";
import assert from "node:assert/strict";

import { McpApiKey } from "../../Schema_Models/McpApiKey.js";
import { UserModel } from "../../Schema_Models/UserModel.js";
import { JobModel } from "../../Schema_Models/JobModel.js";
import { generateMcpKey, isMcpKeyShape, hashMcpKey, displayPrefix, cleanKeyName, MAX_ACTIVE_KEYS } from "../mcpApiKey.js";
import { invokeHandlers } from "../../src/mcp/invokeHandlers.js";
import { baseStatus, getJob, listJobs, EDITABLE_PROFILE_FIELDS } from "../../src/mcp/userTools.js";
import { authenticateMcpKey, buildMcpServer } from "../../src/mcp/server.js";
import { listMcpKeys, createMcpKey } from "../../Controllers/McpKeys.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (payload) => ((res.body = payload), res);
  res.set = (k, v) => (typeof k === "object" ? Object.assign(res.headers, k) : (res.headers[k] = v), res);
  return res;
}

// Chainable stand-in for a Mongoose query: .select().lean().sort() resolve to `value`.
function query(value) {
  const q = Promise.resolve(value);
  q.select = () => q;
  q.lean = () => q;
  q.sort = () => q;
  return q;
}

function stub(obj, name, impl) {
  const original = obj[name];
  obj[name] = impl;
  return () => {
    obj[name] = original;
  };
}

const ctx = { keyId: "k1", email: "asha@example.com", accountEmail: "asha@example.com", name: "Asha" };

test("keys: shape, hash and display prefix", () => {
  const key = generateMcpKey();
  assert.ok(isMcpKeyShape(key));
  assert.equal(key.length, 6 + 43);
  assert.notEqual(generateMcpKey(), key, "every key is random");
  assert.equal(hashMcpKey(key), hashMcpKey(key));
  assert.equal(hashMcpKey(key).length, 64);
  assert.ok(key.startsWith(displayPrefix(key)) && displayPrefix(key).length === 14);
  for (const bad of ["", "ffmcp_short", `ffmcp_${"a".repeat(42)}!`, `sk_${"a".repeat(43)}`, null, 42]) {
    assert.equal(isMcpKeyShape(bad), false, String(bad));
  }
  assert.equal(cleanKeyName("  My   laptop "), "My laptop");
  assert.equal(cleanKeyName(""), "Claude");
  assert.equal(cleanKeyName("x".repeat(80)).length, 60);
});

test("baseStatus maps stored statuses to board columns", () => {
  assert.equal(baseStatus("applied by Ravi"), "applied");
  assert.equal(baseStatus("deleted by user"), "removed");
  assert.equal(baseStatus("Removed"), "removed");
  assert.equal(baseStatus(""), "saved");
  assert.equal(baseStatus("interviewing"), "interviewing");
});

test("invokeHandlers runs the chain and captures status and body", async () => {
  const seen = [];
  const out = await invokeHandlers(
    [
      (req, res, next) => (seen.push(req.body.a), next()),
      (req, res) => res.status(409).json({ message: "dup" }),
    ],
    { body: { a: 1 } }
  );
  assert.deepEqual(seen, [1]);
  assert.deepEqual(out, { status: 409, body: { message: "dup" } });

  await assert.rejects(invokeHandlers([async () => { throw new Error("boom"); }]), /boom/);
  await assert.rejects(invokeHandlers([() => {}], { timeoutMs: 20 }), /handler_timeout/);
  await assert.rejects(invokeHandlers([(req, res, next) => next()]), /without_response/);
});

test("auth: malformed, unknown and orphaned keys get 401; a live key resolves its owner", async () => {
  const key = generateMcpKey();
  const doc = { _id: "abc123", email: "asha@example.com", keyHash: hashMcpKey(key), lastUsedAt: new Date() };
  let keyLookups = 0;
  const restore = [
    stub(McpApiKey, "findOne", (filter) => {
      keyLookups++;
      assert.equal(filter.revokedAt, null, "revoked keys are never matched");
      return query(filter.keyHash === doc.keyHash ? doc : null);
    }),
    stub(UserModel, "findOne", () => query({ email: "Asha@Example.com", name: "Asha" })),
  ];
  try {
    const call = async (headers, params = {}) => {
      const res = fakeRes();
      const ctxOut = await authenticateMcpKey({ headers, params, ip: `ip-${Math.random()}` }, res);
      return { ctxOut, res };
    };

    let r = await call({});
    assert.equal(r.ctxOut, null);
    assert.equal(r.res.statusCode, 401);
    assert.match(r.res.headers["WWW-Authenticate"], /Bearer/);
    assert.equal(keyLookups, 0, "a malformed key never reaches the database");

    r = await call({ authorization: `Bearer ${generateMcpKey()}` });
    assert.equal(r.res.statusCode, 401);

    r = await call({ authorization: `Bearer ${key}` });
    assert.deepEqual(r.ctxOut, { keyId: "abc123", email: "asha@example.com", accountEmail: "Asha@Example.com", name: "Asha" });

    r = await call({}, { key });
    assert.equal(r.ctxOut.email, "asha@example.com", "URL key works too");

    restore.push(stub(UserModel, "findOne", () => query(null)));
    r = await call({ authorization: `Bearer ${key}` });
    assert.equal(r.res.statusCode, 401, "a deleted account's key stops working");
  } finally {
    restore.reverse().forEach((fn) => fn());
  }
});

test("auth: 30 bad keys from one address are cut off with 429", async () => {
  const restore = stub(McpApiKey, "findOne", () => query(null));
  try {
    const ip = "203.0.113.9";
    let last;
    for (let i = 0; i < 31; i++) {
      last = fakeRes();
      await authenticateMcpKey({ headers: { authorization: `Bearer ${generateMcpKey()}` }, params: {}, ip }, last);
    }
    assert.equal(last.statusCode, 429);
    assert.ok(Number(last.headers["Retry-After"]) > 0);
  } finally {
    restore();
  }
});

test("tools: every job lookup is pinned to the key's owner", async () => {
  const filters = [];
  const restore = stub(JobModel, "findOne", (filter) => (filters.push(filter), query(null)));
  const restoreFind = stub(JobModel, "find", (filter) => (filters.push(filter), query([])));
  try {
    await assert.rejects(getJob(ctx, { jobID: "2001" }), /No job with jobID 2001/);
    await listJobs(ctx, { search: "a.b*" });
    for (const f of filters) assert.equal(f.userID, "asha@example.com");
    assert.equal(filters[1].$or[0].jobTitle.source, "a\\.b\\*", "search text is escaped, not a regex");
  } finally {
    restore();
    restoreFind();
  }
});

test("tool surface: 10 client tools, none takes an email or reaches operator data", async () => {
  const server = buildMcpServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientT);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "add_job", "get_job", "get_overview", "get_plan_usage", "get_profile",
      "list_documents", "list_jobs", "remove_job", "update_job_status", "update_profile",
    ]);
    for (const t of tools) {
      const props = Object.keys(t.inputSchema?.properties || {});
      assert.ok(!props.some((p) => /^(email|userEmail|userID|userDetails|role|clientEmail|operations\w*|operator\w*)$/i.test(p)), `${t.name} must not accept identity: ${props}`);
    }
    const move = tools.find((t) => t.name === "update_job_status");
    assert.ok(!move.inputSchema.properties.status.enum.includes("deleted"), "removal goes through remove_job with a reason");
    assert.equal(tools.find((t) => t.name === "remove_job").annotations.destructiveHint, true);
    assert.ok(!EDITABLE_PROFILE_FIELDS.some((f) => /ssn|dob|email|dashboardManager/i.test(f)));
  } finally {
    await client.close();
    await server.close();
  }
});

test("key controller: operator view refused, list never returns the key, limit enforced", async () => {
  const restore = [
    stub(UserModel, "findOne", () => query({ _id: "u1" })),
    stub(McpApiKey, "find", () => query([{ _id: "id1", name: "Laptop", prefix: "ffmcp_abcd1234", keyHash: "secret-hash", createdAt: new Date() }])),
    stub(McpApiKey, "countDocuments", async () => MAX_ACTIVE_KEYS),
  ];
  try {
    let res = fakeRes();
    await listMcpKeys({ authEmail: "asha@example.com", user: { email: "asha@example.com", via: "operations" } }, res);
    assert.equal(res.statusCode, 403);

    res = fakeRes();
    await listMcpKeys({ authEmail: "asha@example.com", user: { email: "asha@example.com" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.stringify(res.body).includes("secret-hash"), false);
    assert.deepEqual(Object.keys(res.body.keys[0]).sort(), ["createdAt", "id", "lastUsedAt", "name", "prefix"]);

    res = fakeRes();
    await createMcpKey({ authEmail: "asha@example.com", user: { email: "asha@example.com" }, body: {} }, res);
    assert.equal(res.statusCode, 409);
  } finally {
    restore.reverse().forEach((fn) => fn());
  }
});
