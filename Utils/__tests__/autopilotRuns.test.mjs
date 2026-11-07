// Controller tests for the autopilot run history + scrape queue.
//
// There is no mongod and no mongodb-memory-server in this repo, and this Node
// build has no test.mock.module, so the Mongoose models are stubbed in place:
// the controller imports the same module object we patch here, so the real
// controller code runs against fake model methods. That covers everything that
// is actually ours - validation, the rejected arithmetic, enum clamping, the
// duplicate-key to 409 mapping, aggregation shaping - without pretending to
// test Mongoose itself.

import test from "node:test";
import assert from "node:assert/strict";

import { AutopilotRun } from "../../Schema_Models/AutopilotRun.js";
import { AutopilotRunRequest } from "../../Schema_Models/AutopilotRunRequest.js";
import { JobModel } from "../../Schema_Models/JobModel.js";
import {
  recordAutopilotRun,
  getAutopilotRunsSummary,
  queueAutopilotRun,
  claimAutopilotRequests,
  cancelAutopilotRequest,
  finishAutopilotRequest,
  mergeSourceCounts,
  SOURCE_LABELS
} from "../../Controllers/AutopilotRuns.js";

/** Minimal Express res double that records what the controller sent. */
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

/** Swap a method on a model, run the test, always restore. */
async function withStub(model, name, impl, fn) {
  const original = model[name];
  model[name] = impl;
  try {
    return await fn();
  } finally {
    model[name] = original;
  }
}

// ── recordAutopilotRun ────────────────────────────────────────────────

test("recordAutopilotRun rejects a body with no usable client email", async () => {
  for (const clientEmail of [undefined, "", "   ", "not-an-email"]) {
    const res = fakeRes();
    await recordAutopilotRun({ body: { clientEmail } }, res);
    assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(clientEmail)}`);
    assert.equal(res.body.success, false);
  }
});

test("recordAutopilotRun derives rejected as captured minus pushed", async () => {
  let saved = null;
  await withStub(AutopilotRun, "create", async (doc) => {
    saved = doc;
    return { _id: "run1" };
  }, async () => {
    const res = fakeRes();
    await recordAutopilotRun(
      { body: { clientEmail: "A@Example.COM ", captured: 38, pushed: 6, rejected: 999 } },
      res
    );
    assert.equal(res.statusCode, 201);
  });
  // The posted rejected value (999) is ignored in favour of our own arithmetic.
  assert.equal(saved.rejected, 32);
  assert.equal(saved.captured, 38);
  assert.equal(saved.pushed, 6);
  // Email is normalised so lookups from the portal match.
  assert.equal(saved.clientEmail, "a@example.com");
});

test("recordAutopilotRun never lets rejected go negative", async () => {
  // The panel's counters can be read mid-update, so pushed > captured happens.
  let saved = null;
  await withStub(AutopilotRun, "create", async (doc) => {
    saved = doc;
    return { _id: "run2" };
  }, async () => {
    const res = fakeRes();
    await recordAutopilotRun({ body: { clientEmail: "a@b.com", captured: 2, pushed: 9 } }, res);
    assert.equal(res.statusCode, 201);
  });
  assert.equal(saved.rejected, 0);
});

test("recordAutopilotRun coerces junk counters to 0 rather than NaN", async () => {
  // A NaN reaching Mongo would poison every $sum in the summary aggregation.
  let saved = null;
  await withStub(AutopilotRun, "create", async (doc) => {
    saved = doc;
    return { _id: "run3" };
  }, async () => {
    const res = fakeRes();
    await recordAutopilotRun(
      {
        body: {
          clientEmail: "a@b.com",
          captured: "banana",
          pushed: null,
          picks: -5,
          dupes: undefined,
          blocked: "7",
          errors: 1.6
        }
      },
      res
    );
    assert.equal(res.statusCode, 201);
  });
  for (const key of ["captured", "pushed", "picks", "dupes"]) {
    assert.equal(saved[key], 0, `${key} should coerce to 0`);
    assert.ok(!Number.isNaN(saved[key]));
  }
  assert.equal(saved.blocked, 7, "numeric strings still count");
  assert.equal(saved.errorCount, 2, "fractional counters round");
});

test("recordAutopilotRun stores errors under errorCount, not the reserved 'errors'", async () => {
  // `errors` is a reserved Mongoose document property; shadowing it breaks
  // doc.validate(). This test fails if someone renames it back.
  let saved = null;
  await withStub(AutopilotRun, "create", async (doc) => {
    saved = doc;
    return { _id: "run4" };
  }, async () => {
    await recordAutopilotRun({ body: { clientEmail: "a@b.com", errors: 3 } }, fakeRes());
  });
  assert.equal(saved.errorCount, 3);
  assert.equal(saved.errors, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(AutopilotRun.schema.paths, "errors"));
});

test("recordAutopilotRun clamps severity and trigger to their allowed values", async () => {
  let saved = null;
  await withStub(AutopilotRun, "create", async (doc) => {
    saved = doc;
    return { _id: "run5" };
  }, async () => {
    await recordAutopilotRun(
      { body: { clientEmail: "a@b.com", severity: "catastrophic", trigger: "cron" } },
      fakeRes()
    );
  });
  assert.equal(saved.severity, "", "an unknown severity becomes empty, not stored raw");
  assert.equal(saved.trigger, "manual", "an unknown trigger falls back to manual");
});

test("recordAutopilotRun keeps the europe trigger so the portal can tag Europe runs", async () => {
  let saved = null;
  await withStub(AutopilotRun, "create", async (doc) => {
    saved = doc;
    return { _id: "run6" };
  }, async () => {
    await recordAutopilotRun(
      { body: { clientEmail: "a@b.com", trigger: "europe", why: "0 pushed: Indeed: robot check" } },
      fakeRes()
    );
  });
  assert.equal(saved.trigger, "europe");
  assert.equal(saved.why, "0 pushed: Indeed: robot check");
});

test("recordAutopilotRun records a failed run rather than dropping it", async () => {
  // A failed run is exactly the row ops needs to see.
  let saved = null;
  await withStub(AutopilotRun, "create", async (doc) => {
    saved = doc;
    return { _id: "run6" };
  }, async () => {
    const res = fakeRes();
    await recordAutopilotRun(
      {
        body: {
          clientEmail: "a@b.com",
          captured: 0,
          pushed: 0,
          outcome: "jr-login-failed",
          outcomeLabel: "JobRight login failed",
          severity: "bad",
          errorText: "password rejected"
        }
      },
      res
    );
    assert.equal(res.statusCode, 201);
  });
  assert.equal(saved.severity, "bad");
  assert.equal(saved.outcome, "jr-login-failed");
});

// ── getAutopilotRunsSummary ───────────────────────────────────────────

test("getAutopilotRunsSummary flattens each group and totals across clients", async () => {
  const groups = [
    {
      _id: "a@b.com",
      lastRun: {
        clientName: "Ann",
        profile: "a-b-com",
        captured: 38,
        pushed: 6,
        rejected: 32,
        cap: 30,
        minutes: 4.2,
        outcome: "list-exhausted",
        outcomeLabel: "No more jobs",
        why: "Reached the end of the list",
        severity: "good",
        errorText: "",
        trigger: "schedule",
        finishedAt: new Date("2026-09-09T10:00:00Z")
      },
      runs: 2,
      totalCaptured: 50,
      totalPushed: 10,
      totalRejected: 40,
      totalMinutes: 8.25,
      failedRuns: 0
    },
    {
      _id: "c@d.com",
      lastRun: {
        clientName: "Cy",
        profile: "c-d-com",
        captured: 0,
        pushed: 0,
        rejected: 0,
        cap: 30,
        minutes: 1.5,
        outcome: "jr-login-failed",
        outcomeLabel: "JobRight login failed",
        why: "password rejected",
        severity: "bad",
        errorText: "boom",
        trigger: "portal",
        finishedAt: new Date("2026-09-09T09:00:00Z")
      },
      runs: 1,
      totalCaptured: 0,
      totalPushed: 0,
      totalRejected: 0,
      totalMinutes: 1.5,
      failedRuns: 1
    }
  ];

  const res = fakeRes();
  await withStub(AutopilotRun, "aggregate", async () => groups, async () => {
    await getAutopilotRunsSummary({ query: { days: "7" } }, res);
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.days, 7);
  assert.equal(res.body.count, 2);

  const [first, second] = res.body.data;
  assert.equal(first.clientEmail, "a@b.com");
  assert.equal(first.clientName, "Ann");
  assert.equal(first.lastPushed, 6);
  assert.equal(first.lastRejected, 32);
  assert.equal(first.lastSeverity, "good");
  assert.equal(first.totalMinutes, 8.3, "minutes round to one decimal");
  assert.equal(second.lastSeverity, "bad");

  assert.deepEqual(res.body.totals, {
    clients: 2,
    runs: 3,
    captured: 50,
    pushed: 10,
    rejected: 40,
    failedRuns: 1
  });
});

test("getAutopilotRunsSummary clamps the days window into a sane range", async () => {
  for (const [given, expected] of [["0", 30], ["-5", 30], ["9999", 365], ["abc", 30], ["1", 1]]) {
    const res = fakeRes();
    await withStub(AutopilotRun, "aggregate", async () => [], async () => {
      await getAutopilotRunsSummary({ query: { days: given } }, res);
    });
    assert.equal(res.body.days, expected, `days=${given} should clamp to ${expected}`);
  }
});

test("getAutopilotRunsSummary returns empty totals rather than throwing on no data", async () => {
  const res = fakeRes();
  await withStub(AutopilotRun, "aggregate", async () => [], async () => {
    await getAutopilotRunsSummary({ query: {} }, res);
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.totals.clients, 0);
  assert.equal(res.body.totals.pushed, 0);
});

// ── queueAutopilotRun ─────────────────────────────────────────────────

test("queueAutopilotRun turns a duplicate-key error into a clear 409", async () => {
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "create", async () => {
    const err = new Error("E11000 duplicate key error");
    err.code = 11000;
    throw err;
  }, async () => {
    await queueAutopilotRun({ body: { clientEmail: "a@b.com" } }, res);
  });
  assert.equal(res.statusCode, 409, "a double click must not read as a server error");
  assert.match(res.body.message, /already has a scrape queued or running/i);
});

test("queueAutopilotRun leaves maxJobs null when it is not supplied", async () => {
  // Defaulting to 30 here would silently override a client set lower.
  let saved = null;
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "create", async (doc) => {
    saved = doc;
    return { _id: "q1", status: "queued" };
  }, async () => {
    await queueAutopilotRun({ body: { clientEmail: "A@B.com" } }, res);
  });
  assert.equal(res.statusCode, 201);
  assert.equal(saved.maxJobs, null);
  assert.equal(saved.clientEmail, "a@b.com");
  assert.equal(saved.status, "queued");
});

test("queueAutopilotRun rejects a maxJobs outside 1..30", async () => {
  for (const bad of [0, -1, 31, 100, "abc", 2.5]) {
    const res = fakeRes();
    await withStub(AutopilotRunRequest, "create", async () => {
      throw new Error("create should not be reached for " + bad);
    }, async () => {
      await queueAutopilotRun({ body: { clientEmail: "a@b.com", maxJobs: bad } }, res);
    });
    assert.equal(res.statusCode, 400, `maxJobs=${bad} should be rejected`);
  }
});

test("queueAutopilotRun accepts a valid maxJobs override", async () => {
  let saved = null;
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "create", async (doc) => {
    saved = doc;
    return { _id: "q2", status: "queued" };
  }, async () => {
    await queueAutopilotRun({ body: { clientEmail: "a@b.com", maxJobs: "12", requestedBy: "admin@x.com" } }, res);
  });
  assert.equal(res.statusCode, 201);
  assert.equal(saved.maxJobs, 12);
  assert.equal(saved.requestedBy, "admin@x.com");
});

test("queueAutopilotRun rejects a bad client email", async () => {
  const res = fakeRes();
  await queueAutopilotRun({ body: { clientEmail: "nope" } }, res);
  assert.equal(res.statusCode, 400);
});

// ── claimAutopilotRequests ────────────────────────────────────────────

test("claimAutopilotRequests stops as soon as the queue is empty", async () => {
  let calls = 0;
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "findOneAndUpdate", () => {
    calls += 1;
    // Two queued rows, then nothing.
    const doc = calls <= 2 ? { _id: `q${calls}`, clientEmail: `c${calls}@x.com` } : null;
    return { lean: async () => doc };
  }, async () => {
    await claimAutopilotRequests({ body: { claimedBy: "vps1", limit: 7 } }, res);
  });
  assert.equal(res.body.count, 2);
  assert.equal(calls, 3, "one extra call discovers the empty queue, then it stops");
});

test("claimAutopilotRequests clamps the requested batch size", async () => {
  let calls = 0;
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "findOneAndUpdate", () => {
    calls += 1;
    return { lean: async () => ({ _id: `q${calls}` }) };
  }, async () => {
    await claimAutopilotRequests({ body: { limit: 9999 } }, res);
  });
  assert.equal(calls, 20, "never claims more than 20 in one poll");
  assert.equal(res.body.count, 20);
});

// ── cancel / finish ───────────────────────────────────────────────────

test("cancelAutopilotRequest refuses once the run has already been claimed", async () => {
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "findOneAndUpdate", () => ({ lean: async () => null }), async () => {
    await cancelAutopilotRequest({ params: { id: "64b7f9c2e1a2b3c4d5e6f701" }, body: {} }, res);
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /has not started yet/i);
});

test("cancelAutopilotRequest rejects a malformed id instead of querying", async () => {
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "findOneAndUpdate", () => {
    throw new Error("should not query on a bad id");
  }, async () => {
    await cancelAutopilotRequest({ params: { id: "not-an-objectid" }, body: {} }, res);
  });
  assert.equal(res.statusCode, 400);
});

test("finishAutopilotRequest defaults an unknown status to done and 404s a missing row", async () => {
  let update = null;
  let res = fakeRes();
  await withStub(AutopilotRunRequest, "findByIdAndUpdate", (_id, payload) => {
    update = payload;
    return { lean: async () => ({ _id, ...payload.$set }) };
  }, async () => {
    await finishAutopilotRequest(
      { params: { id: "64b7f9c2e1a2b3c4d5e6f701" }, body: { status: "exploded" } },
      res
    );
  });
  assert.equal(res.statusCode, 200);
  assert.equal(update.$set.status, "done");

  res = fakeRes();
  await withStub(AutopilotRunRequest, "findByIdAndUpdate", () => ({ lean: async () => null }), async () => {
    await finishAutopilotRequest(
      { params: { id: "64b7f9c2e1a2b3c4d5e6f702" }, body: { status: "done" } },
      res
    );
  });
  assert.equal(res.statusCode, 404);
});

test("finishAutopilotRequest keeps a failed status and ignores a bogus runId", async () => {
  let update = null;
  const res = fakeRes();
  await withStub(AutopilotRunRequest, "findByIdAndUpdate", (_id, payload) => {
    update = payload;
    return { lean: async () => ({ _id }) };
  }, async () => {
    await finishAutopilotRequest(
      {
        params: { id: "64b7f9c2e1a2b3c4d5e6f703" },
        body: { status: "failed", outcome: "jr-login-failed", runId: "garbage" }
      },
      res
    );
  });
  assert.equal(update.$set.status, "failed");
  assert.equal(update.$set.outcome, "jr-login-failed");
  assert.equal(update.$set.runId, undefined, "an invalid runId is dropped, not written");
});


// ── per-portal breakdown ──────────────────────────────────────────────

test("mergeSourceCounts sums per-portal maps and ignores null", () => {
  assert.deepEqual(
    mergeSourceCounts([{ jobright: 3, "indeed-api": 2 }, null, { jobright: 1, "glassdoor-scrape": 4 }]),
    { jobright: 4, "indeed-api": 2, "glassdoor-scrape": 4 },
  );
  assert.deepEqual(mergeSourceCounts([]), {});
});

test("getAutopilotRunsSummary adds totals.bySource and sourceLabels", async () => {
  const groups = [{
    _id: "a@b.com",
    lastRun: { clientName: "Ann", finishedAt: new Date("2026-11-07T10:00:00Z"), severity: "good" },
    runs: 1, totalCaptured: 10, totalPushed: 7, totalRejected: 3, totalMinutes: 2, failedRuns: 0,
  }];
  const sourceRows = [
    { _id: "jobright", n: 5 }, { _id: "hiringcafe-scrape", n: 2 },
  ];
  const res = fakeRes();
  await withStub(AutopilotRun, "aggregate", async () => groups, async () => {
    await withStub(JobModel, "aggregate", async () => sourceRows, async () => {
      await getAutopilotRunsSummary({ query: { days: "7" } }, res);
    });
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.totals.bySource, { jobright: 5, "hiringcafe-scrape": 2 });
  assert.equal(res.body.sourceLabels["indeed-api"], "Indeed");
});

test("getAutopilotRunsSummary still returns when the breakdown query throws", async () => {
  const res = fakeRes();
  await withStub(AutopilotRun, "aggregate", async () => [], async () => {
    await withStub(JobModel, "aggregate", async () => { throw new Error("no mongo"); }, async () => {
      await getAutopilotRunsSummary({ query: { days: "7" } }, res);
    });
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totals.bySource, undefined);
});

test("SOURCE_LABELS names every portal, JobRight for the unset source", () => {
  assert.equal(SOURCE_LABELS.jobright, "JobRight");
  assert.equal(SOURCE_LABELS["glassdoor-scrape"], "Glassdoor");
});
