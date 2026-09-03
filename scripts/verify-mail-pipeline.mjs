// Verification for the Gmail → gpt-4o-mini → Discord pipeline.
//
//   npm run verify:mail
//
// Runs the REAL summarizeMail / notifyMailDigest / notifyGmailAuthError code
// paths against local stub servers standing in for OpenAI and Discord. Needs no
// production credentials, no network, and no Mongo — so it is safe to run
// anywhere, any time.
//
// What it does NOT cover: pollMailbox()'s cursor + dedupe orchestration, which
// needs a live Gmail account and a Mongo instance. Verify that on staging.

import http from "node:http";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

function listen(handler) {
  return new Promise((res) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const readBody = (req) => new Promise((res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => res(Buffer.concat(chunks)));
});

// ─────────────────────────────────────────────────────────────
console.log("\n[1] Pure helpers — Utils/gmailMessage.js");
{
  const { extractUrls, htmlToText, parseFromHeader, isTextLike } = await import(`../Utils/gmailMessage.js`);

  const urls = extractUrls("Apply at https://jobs.acme.com/a-123. Also see https://x.io/b, and https://jobs.acme.com/a-123 again");
  ok("extractUrls strips trailing period", urls[0] === "https://jobs.acme.com/a-123", urls[0]);
  ok("extractUrls strips trailing comma", urls[1] === "https://x.io/b", urls[1]);
  ok("extractUrls dedupes", urls.length === 2, JSON.stringify(urls));

  ok("htmlToText flattens tags", htmlToText("<p>Hello<br>World</p>").includes("Hello") && htmlToText("<p>Hi<br>Yo</p>").includes("Yo"));
  ok("htmlToText drops <script>", !htmlToText("<script>evil()</script><p>safe</p>").includes("evil"));
  ok("htmlToText decodes entities", htmlToText("<p>a &amp; b</p>") === "a & b", htmlToText("<p>a &amp; b</p>"));

  ok("parseFromHeader splits name/email",
    parseFromHeader('"Jobs Bot" <bot@Acme.com>').email === "bot@acme.com" &&
    parseFromHeader('"Jobs Bot" <bot@Acme.com>').name === "Jobs Bot");
  ok("parseFromHeader bare address", parseFromHeader("x@y.com").email === "x@y.com");

  ok("isTextLike accepts .txt", isTextLike({ filename: "jobs.txt", mimetype: "text/plain" }));
  ok("isTextLike accepts text/* mimetype", isTextLike({ filename: "f", mimetype: "text/csv" }));
  ok("isTextLike rejects pdf", !isTextLike({ filename: "resume.pdf", mimetype: "application/pdf" }));
}

// ─────────────────────────────────────────────────────────────
console.log("\n[2] summarizeMail — real request path vs stub OpenAI");
{
  const captured = [];
  let mode = "good";
  const { srv, url } = await listen(async (req, res) => {
    captured.push(JSON.parse((await readBody(req)).toString()));
    if (mode === "500") { res.writeHead(500); return res.end("upstream boom"); }
    if (mode === "junk") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "Acme invited the client to a technical interview on Friday.",
        keyPoints: ["Interview Friday 3pm", "Round: system design"],
        category: "interview",
        priority: "high",
        actionRequired: "Confirm the slot with Acme.",
        // A hallucinated link that never appeared in the mail:
        primaryUrl: mode === "halluc" ? "https://evil.example.com/phish" : "https://jobs.acme.com/a-123",
      }) } }],
    }));
  });

  process.env.MAIL_AI_API_URL = `${url}/v1/chat/completions`;
  process.env.OPENAI_API_KEY = "sk-test-fake";
  process.env.MAIL_AI_MODEL = "gpt-4o-mini";
  const { summarizeMail } = await import(`../src/services/mailAiSummarizer.js`);

  const mail = {
    from: '"Acme Talent" <talent@acme.com>',
    subject: "Interview invite",
    date: new Date("2026-07-09T10:00:00Z"),
    bodyText: "Hi! Please book a slot: https://jobs.acme.com/a-123 . Details attached.",
    attachments: [{ filename: "details.txt", text: "Round: system design\nTime: Friday 3pm" }],
  };

  const good = await summarizeMail(mail);
  ok("aiSucceeded on happy path", good.aiSucceeded === true, good.aiError);
  ok("model name recorded", good.aiModel === "gpt-4o-mini", good.aiModel);
  ok("summary passed through", good.summary.startsWith("Acme invited"));
  ok("enum category honoured", good.category === "interview");
  ok("enum priority honoured", good.priority === "high");
  ok("keyPoints capped + kept", good.keyPoints.length === 2);
  ok("valid primaryUrl floated to front", good.urls[0] === "https://jobs.acme.com/a-123", JSON.stringify(good.urls));
  ok("attachment text reached the prompt", captured[0].messages[1].content.includes("system design"));
  ok("temperature 0 + json_object", captured[0].temperature === 0 && captured[0].response_format.type === "json_object");

  mode = "halluc";
  const h = await summarizeMail(mail);
  ok("hallucinated primaryUrl rejected", !h.urls.includes("https://evil.example.com/phish"), JSON.stringify(h.urls));
  ok("regex urls still present after rejection", h.urls[0] === "https://jobs.acme.com/a-123");

  mode = "500";
  const f = await summarizeMail(mail);
  ok("fail-open on OpenAI 5xx", f.aiSucceeded === false && f.summary === "");
  ok("fail-open still returns regex urls", f.urls[0] === "https://jobs.acme.com/a-123", JSON.stringify(f.urls));
  ok("fail-open records the error", /500/.test(f.aiError), f.aiError);

  mode = "junk";
  const j = await summarizeMail(mail);
  ok("fail-open on unparseable JSON", j.aiSucceeded === false && /unparseable/i.test(j.aiError), j.aiError);

  delete process.env.OPENAI_API_KEY;
  const nk = await summarizeMail(mail);
  ok("fail-open when no API key", nk.aiSucceeded === false && /not configured/i.test(nk.aiError), nk.aiError);
  ok("no-key path still extracts urls", nk.urls.length === 1);

  srv.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n[3] notifyMailDigest — real multipart upload vs stub Discord");
{
  const hits = [];
  let force429Once = true;
  const { srv, url } = await listen(async (req, res) => {
    const raw = await readBody(req);
    hits.push({ ct: req.headers["content-type"] || "", raw });
    if (force429Once && hits.length === 1) {
      force429Once = false;
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ retry_after: 0.05 }));
    }
    res.writeHead(204);
    res.end();
  });

  // The webhook is hard-coded in the module; override it to the local stub so
  // NOTHING reaches the real Discord channel. Must be set before first import.
  process.env.ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS = `${url}/webhook`;
  const { notifyMailDigest, notifyGmailAuthError, isGmailAuthError } =
    await import(`../Utils/discordMailNotify.js`);

  const txt = Buffer.from("job 1\njob 2\njob 3\n");
  const r = await notifyMailDigest({
    client: { name: "Priya Sharma", email: "priya@client.com", planType: "Executive", dashboardManager: "ops@ff.io" },
    mailbox: "priya.jobs@gmail.com",
    digest: {
      subject: "Daily job matches",
      from: '"Jobs Bot" <bot@acme.com>',
      date: new Date("2026-07-09T10:00:00Z"),
      summary: "12 new roles matched, 3 are senior backend positions.",
      keyPoints: ["3 senior backend", "2 remote"],
      category: "job-alert",
      priority: "medium",
      actionRequired: "Review the 3 senior roles.",
      urls: ["https://jobs.acme.com/a-123", "https://jobs.acme.com/b-456"],
      aiSucceeded: true,
      aiModel: "gpt-4o-mini",
      attachments: [],
    },
    files: [{ filename: "matches.txt", contentType: "text/plain", buffer: txt }],
    counts: { totalForClient: 42, newThisRun: 3 },
  });

  ok("delivery ok after 429 retry", r.ok === true, r.error);
  ok("429 was actually retried", hits.length === 2, `hits=${hits.length}`);

  const last = hits[1];
  const body = last.raw.toString("utf8");
  ok("multipart content-type", last.ct.startsWith("multipart/form-data"), last.ct);
  ok("payload_json part present", body.includes('name="payload_json"'));
  ok("file part present", body.includes('name="files[0]"') && body.includes('filename="matches.txt"'));
  ok("file bytes uploaded", body.includes("job 1") && body.includes("job 3"));

  const m = body.match(/name="payload_json"\r?\n\r?\n([\s\S]*?)\r?\n------/);
  const payload = JSON.parse(m[1]);
  const embed = payload.embeds[0];
  ok("client name in embed author", embed.author.name === "Priya Sharma");
  const flat = JSON.stringify(embed);
  ok("client plan in embed", flat.includes("Executive"));
  ok("lifetime count in embed", flat.includes("42 mails"), flat.slice(0, 200));
  ok("new-this-run count in embed", flat.includes("3 new"));
  ok("mailbox in embed", flat.includes("priya.jobs@gmail.com"));
  ok("summary is the description", embed.description.startsWith("12 new roles"));
  ok("links listed", flat.includes("https://jobs.acme.com/b-456"));
  ok("title links to primary url", embed.url === "https://jobs.acme.com/a-123");
  ok("attachment noted in embed", flat.includes("matches.txt"));
  ok("no accidental @everyone", payload.allowed_mentions.parse.length === 0);

  // JSON (no-file) path
  hits.length = 0;
  const r2 = await notifyMailDigest({
    client: { name: "Solo", email: "s@c.com" },
    mailbox: "s@gmail.com",
    digest: { subject: "no attach", summary: "hi", urls: [], aiSucceeded: true, date: new Date() },
    files: [],
    counts: { totalForClient: 1, newThisRun: 1 },
  });
  ok("no-file path succeeds", r2.ok === true, r2.error);
  ok("no-file path uses application/json", hits[0].ct.includes("application/json"), hits[0].ct);

  // Oversized attachment is reported, not silently dropped
  hits.length = 0;
  const big = Buffer.alloc(9_000_000, 0x61);
  const r3 = await notifyMailDigest({
    client: { name: "Big" }, mailbox: "b@gmail.com",
    digest: { subject: "big", summary: "s", urls: [], aiSucceeded: true, date: new Date() },
    files: [{ filename: "huge.txt", contentType: "text/plain", buffer: big }],
    counts: {},
  });
  ok("oversized file skipped, post still sent", r3.ok === true && r3.skipped.length === 1, JSON.stringify(r3.skipped));
  ok("skip reason surfaced in embed", hits[0].raw.toString().includes("not uploaded"));

  // Field-cap safety: absurdly long summary must not exceed Discord's 4096.
  hits.length = 0;
  await notifyMailDigest({
    client: { name: "X" }, mailbox: "x@gmail.com",
    digest: { subject: "y".repeat(600), summary: "z".repeat(9000), urls: [], aiSucceeded: true, date: new Date() },
    files: [], counts: {},
  });
  const e2 = JSON.parse(hits[0].raw.toString()).embeds[0];
  ok("title truncated to 256", e2.title.length <= 256, String(e2.title.length));
  ok("description truncated to 4096", e2.description.length <= 4096, String(e2.description.length));

  // Auth error alert
  hits.length = 0;
  ok("isGmailAuthError catches invalid_grant", isGmailAuthError("invalid_grant"));
  ok("isGmailAuthError catches revoked token", isGmailAuthError("Token has been expired or revoked."));
  ok("isGmailAuthError ignores network noise", !isGmailAuthError("ECONNRESET socket hang up"));

  const ra = await notifyGmailAuthError({
    client: { name: "Priya Sharma", email: "priya@client.com", planType: "Executive" },
    mailbox: "priya.jobs@gmail.com",
    error: "invalid_grant",
    since: new Date("2026-07-09T08:00:00Z"),
  });
  ok("auth alert delivered", ra.ok === true, ra.error);
  const ae = JSON.parse(hits[0].raw.toString()).embeds[0];
  const af = JSON.stringify(ae);
  ok("auth embed says reconnect", /reconnect/i.test(af));
  ok("auth embed is red", ae.color === 0xef4444);
  ok("auth embed names the client", af.includes("Priya Sharma"));
  ok("auth embed names the mailbox", af.includes("priya.jobs@gmail.com"));
  ok("auth embed carries the raw error", af.includes("invalid_grant"));
  ok("auth embed has reconnect deep link", af.includes("portal.flashfirejobs.com/inbox"));

  srv.close();
}

// ─────────────────────────────────────────────────────────────
console.log("\n[3b] Error classification — quota 403 must NOT look like a dead token");
{
  process.env.DISCORD_MAIL_WEBHOOK_URL = "http://127.0.0.1:1/never";
  const { isGmailAuthError, errorText } = await import(`../Utils/discordMailNotify.js?v=classify`);

  // Real googleapis/Gaxios shapes.
  const oauthDead = { message: "invalid_grant", response: { status: 400, data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } };
  const quota403 = { message: "Quota exceeded for quota metric 'Queries'", code: 403, response: { status: 403, data: { error: { code: 403, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded", message: "Rate Limit Exceeded" }] } } } };
  const userRate403 = { message: "User-rate limit exceeded", code: 403, response: { status: 403, data: { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } } } };
  const perms403 = { message: "Insufficient Permission", code: 403, response: { status: 403, data: { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } } } };
  const creds401 = { message: "Invalid Credentials", code: 401, response: { status: 401, data: { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } } } };
  const server500 = { message: "Internal error encountered.", code: 500, response: { status: 500, data: { error: { code: 500, message: "Internal error encountered." } } } };
  const netFlake = { message: "read ECONNRESET", code: "ECONNRESET" };

  ok("errorText flattens oauth error_description", /revoked/i.test(errorText(oauthDead)));
  ok("errorText flattens nested REST reason", /rateLimitExceeded/.test(errorText(quota403)), errorText(quota403));

  ok("invalid_grant → AUTH", isGmailAuthError(errorText(oauthDead)));
  ok("403 rateLimitExceeded → NOT auth", !isGmailAuthError(errorText(quota403)), errorText(quota403));
  ok("403 userRateLimitExceeded → NOT auth", !isGmailAuthError(errorText(userRate403)), errorText(userRate403));
  ok("403 insufficientPermissions → AUTH", isGmailAuthError(errorText(perms403)), errorText(perms403));
  ok("401 Invalid Credentials → AUTH", isGmailAuthError(errorText(creds401)), errorText(creds401));
  ok("500 internal → NOT auth", !isGmailAuthError(errorText(server500)), errorText(server500));
  ok("ECONNRESET → NOT auth", !isGmailAuthError(errorText(netFlake)), errorText(netFlake));

  // Bare numbers must not flip the verdict either way.
  ok("incidental '401' in prose → NOT auth", !isGmailAuthError("processed 401 messages"), "");
  ok("incidental '512' in prose → still auth when invalid_grant present", isGmailAuthError("invalid_grant after 512 bytes"));
}

console.log("\n[4] Unreachable webhook → fail-soft, never throws");
{
  // The webhook is hard-coded, so it can never be "unconfigured"; instead point
  // it at an unreachable address and confirm a post fails soft (ok:false, no throw).
  process.env.ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS = "http://127.0.0.1:1/never";
  const mod = await import(`../Utils/discordMailNotify.js?nocache=${Date.now()}`);
  const r = await mod.notifyMailDigest({ client: {}, mailbox: "a@b.c", digest: { subject: "s", date: new Date() } });
  ok("returns not-ok instead of throwing", r.ok === false && !!r.error, JSON.stringify(r));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
