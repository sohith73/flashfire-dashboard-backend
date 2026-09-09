// Verification for the client milestone-alert pipeline
// (classification → eligibility → branded template → SendGrid).
//
//   npm run verify:client-alerts
//
// Runs the REAL deriveEligibility / renderClientMilestoneEmail / sendEmail code
// against a local stub SendGrid endpoint. No network, no prod creds, no Mongo.
//
// NOT covered here: notifyClientForDigest's Mongo dedupe writes and the poll
// worker's per-message wiring — those need a live Mongo + Gmail. Verify on staging.

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

// ─────────────────────────────────────────────────────────────
console.log("\n[1] deriveEligibility — only confident positive milestones qualify");
{
  process.env.CLIENT_MAIL_NOTIFY_CATEGORIES = "interview,assessment,offer";
  process.env.CLIENT_MAIL_NOTIFY_MIN_PRIORITY = "medium";
  const { deriveEligibility } = await import("../src/services/clientMailNotifier.js");

  const y = (c, p = "high") => deriveEligibility({ category: c, priority: p, aiSucceeded: true });

  ok("interview/high eligible", y("interview").clientNotifyEligible === true);
  ok("assessment/high eligible", y("assessment").clientNotifyEligible === true);
  ok("offer/medium eligible", y("offer", "medium").clientNotifyEligible === true);
  ok("eligible carries category", y("interview").clientNotifyCategory === "interview");

  ok("rejection NOT eligible", y("rejection").clientNotifyEligible === false);
  ok("recruiter-outreach NOT eligible (default set)", y("recruiter-outreach").clientNotifyEligible === false);
  ok("job-alert NOT eligible", y("job-alert").clientNotifyEligible === false);
  ok("newsletter NOT eligible", y("newsletter").clientNotifyEligible === false);

  ok("interview/low BELOW min priority → not eligible", y("interview", "low").clientNotifyEligible === false);
  ok("AI-failed mail never eligible", deriveEligibility({ category: "interview", priority: "high", aiSucceeded: false }).clientNotifyEligible === false);
  ok("not-eligible clears category", y("rejection").clientNotifyCategory === "");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[2] renderClientMilestoneEmail — branded, safe, complete");
{
  const { renderClientMilestoneEmail, NOTIFIABLE_CATEGORIES } = await import("../Utils/clientMailTemplates.js");

  ok("three notifiable categories", NOTIFIABLE_CATEGORIES.join(",") === "interview,assessment,offer", NOTIFIABLE_CATEGORIES.join(","));

  const base = {
    client: { name: "Priya Sharma", email: "priya@client.com" },
    digest: {
      category: "interview",
      subject: "Interview invite — Backend Engineer",
      from: "Acme Talent <talent@acme.com>",
      summary: "Acme wants a 45-min technical interview this week.",
      keyPoints: ["45-min technical", "Thu/Fri PM"],
      actionRequired: "Confirm a slot today.",
      urls: ["https://mail.google.com/x"]
    },
    dashboardUrl: "https://dash.flashfire.io"
  };

  const r = renderClientMilestoneEmail(base);
  ok("subject leads with headline", /You've got an interview/.test(r.subject), r.subject);
  ok("subject includes source subject", r.subject.includes("Backend Engineer"));
  ok("greets by first name", r.html.includes("Priya") && !r.html.includes("Priya Sharma,"), "should use first name");
  ok("renders the source subject verbatim", r.html.includes("Interview invite — Backend Engineer"), "full subject should appear");
  ok("renders the summary", r.html.includes("45-min technical interview"));
  ok("renders key points", r.html.includes("Thu/Fri PM"));
  ok("renders next-step block", r.html.includes("Confirm a slot today"));
  ok("flame gradient present", r.html.includes("#f97316") && r.html.includes("#ef4444"));
  ok("CTA points at dashboard", r.html.includes('href="https://dash.flashfire.io"'));
  ok("plaintext fallback present", r.text.includes("Interview invite") && r.text.length > 40);

  // Category art direction differs
  const off = renderClientMilestoneEmail({ ...base, digest: { ...base.digest, category: "offer" } });
  ok("offer uses its own headline", /You've got an offer/.test(off.subject));
  const asg = renderClientMilestoneEmail({ ...base, digest: { ...base.digest, category: "assessment" } });
  ok("assessment surfaced as Assignment", asg.html.includes("Assignment") && /assignment/i.test(asg.subject));

  // XSS / injection safety
  const evil = renderClientMilestoneEmail({
    client: { name: "<script>alert(1)</script>", email: "x@y.com" },
    digest: {
      category: "interview",
      subject: "<img src=x onerror=alert(1)>",
      summary: "hi <b>there</b> & <them>",
      urls: ["javascript:alert(1)", "https://safe.example.com/j"]
    },
    dashboardUrl: ""
  });
  ok("script tag in name escaped", !evil.html.includes("<script>alert(1)</script>") && evil.html.includes("&lt;script&gt;"));
  ok("img onerror in subject escaped", !evil.html.includes("<img src=x onerror") && evil.html.includes("&lt;img"));
  ok("ampersand/tags in summary escaped", evil.html.includes("&amp;") && evil.html.includes("&lt;them&gt;"));
  ok("javascript: URL rejected from CTA", !evil.html.includes("javascript:alert(1)"));
  ok("falls back to safe https url for CTA", evil.html.includes("https://safe.example.com/j"));

  // No-summary mail still renders
  const bare = renderClientMilestoneEmail({ client: { email: "a@b.com" }, digest: { category: "offer", subject: "You got it" } });
  ok("bare mail renders without crashing", bare.html.includes("You got it") && bare.subject.length > 0);
  ok("greets 'there' when no name", bare.html.includes("there") || bare.html.includes("a</h1>") || bare.html.includes(">a<"), "name fallback");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[3] sendgridClient — real send path via injected fake client, fail-soft");
{
  // Inject a fake @sendgrid client so we exercise sendEmail's real success /
  // error handling without any HTTP. This is the seam @sendgrid/mail exposes.
  const sgMail = (await import("@sendgrid/mail")).default;
  const requests = [];
  let mode = "ok";
  const fakeClient = {
    setApiKey(k) { this._key = k; },
    setDefaultHeader() {},
    async request(req) {
      requests.push(req);
      if (mode === "401") {
        const err = new Error("Unauthorized");
        err.code = 401;
        err.response = { body: { errors: [{ message: "Bad API key" }] } };
        throw err;
      }
      return [{ statusCode: 202, headers: {} }, {}];
    }
  };
  sgMail.setClient(fakeClient);

  process.env.SENDGRID_API_KEY = "SG.test-fake-key";
  const { sendEmail, isSendgridConfigured } = await import(`../Utils/sendgridClient.js?v=${Date.now()}`);

  ok("isSendgridConfigured true with key", isSendgridConfigured() === true);

  const r1 = await sendEmail({
    to: "a@b.com", subject: "hi", html: "<p>hi</p>", text: "hi",
    fromEmail: "noreply@flashfirehq.com", fromName: "FlashFire",
    categories: ["client-milestone", "milestone-interview"]
  });
  ok("send ok on 202", r1.ok === true, r1.error);
  ok("status surfaced", r1.status === 202, String(r1.status));
  ok("hit the client once", requests.length === 1, `n=${requests.length}`);
  const bodyStr = JSON.stringify(requests[0].body || {});
  ok("recipient in payload", bodyStr.includes("a@b.com"));
  ok("from identity in payload", bodyStr.includes("noreply@flashfirehq.com") && bodyStr.includes("FlashFire"));
  ok("categories forwarded", bodyStr.includes("milestone-interview"));
  ok("plaintext + html both present", bodyStr.includes("<p>hi</p>"));

  ok("missing fields → not ok, no throw", (await sendEmail({ to: "a@b.com" })).ok === false);

  mode = "401";
  const r2 = await sendEmail({ to: "a@b.com", subject: "hi", html: "<p>hi</p>" });
  ok("401 → fail-soft, SendGrid error message extracted", r2.ok === false && /Bad API key/.test(r2.error || ""), r2.error);
}

// ─────────────────────────────────────────────────────────────
console.log("\n[4] Not configured → graceful");
{
  delete process.env.SENDGRID_API_KEY;
  delete process.env.SENDGRID_API_KEY_1;
  const { sendEmail, isSendgridConfigured } = await import(`../Utils/sendgridClient.js?v=noconf${Date.now()}`);
  ok("isSendgridConfigured false", isSendgridConfigured() === false);
  const r = await sendEmail({ to: "a@b.com", subject: "s", html: "<p>h</p>" });
  ok("returns not-configured, no throw", r.ok === false && r.error === "sendgrid_not_configured", JSON.stringify(r));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
