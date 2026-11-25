// mailJevBackfill - run Jev over a client's PREVIOUS mails and report on Discord.
//
// The Jev watch switch (mailJevWatch.js) only covers mail the hourly poll reads
// from now on. Operators also want to see what Jev makes of the mail already
// scanned, so this re-reads the stored digests with the same triage call and
// posts the result to the Jev watch channel.
//
// Read-only by design. Nothing is written to the digests, no client is
// emailed and no card is moved: replaying old mail through the live pipeline
// would send clients alerts for interviews that happened weeks ago. The card
// says what Jev picked next to what the pipeline recorded at the time, so the
// disagreements are what an operator reads.
//
// Old mail is judged on sender, subject and the stored preview: the full body
// is never stored (MailDigest keeps the snippet), so the card says so.

import { MailDigest } from "../../Schema_Models/MailDigest.js";
import { triageMail, triageFlags, RULE_FLAGGED_CATEGORIES } from "./mailAiTriage.js";
import { triageSkipReason } from "../../Utils/mailPromoFilter.js";
import { notifyJevWatch } from "../../Utils/discordMailNotify.js";
import { triageEngine } from "./mailJevWatch.js";

export const BACKFILL_DEFAULT_LIMIT = 500;
export const BACKFILL_MAX_LIMIT = 1000;
const CONCURRENCY = 4;
const EMBEDS_PER_MESSAGE = 10; // Discord's cap
const MESSAGE_BUDGET = 5600; // Discord's cap is 6000 characters per message, all embeds together
const DESCRIPTION_BUDGET = 2600; // one findings embed; leaves room for the "more not shown" tail
const MAX_MESSAGES = 3; // 30 embeds of findings is already more than anyone reads

// One run per client at a time; a second click while it runs gets a 409.
const running = new Set();
export const isBackfillRunning = (email) => running.has(String(email || "").toLowerCase().trim());

/** Clamp the requested mail count. */
export function backfillLimit(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return BACKFILL_DEFAULT_LIMIT;
  return Math.min(v, BACKFILL_MAX_LIMIT);
}

const MILESTONES = RULE_FLAGGED_CATEGORIES; // interview, assessment, offer, rejection

/**
 * What the pipeline ended up treating the mail as. A milestone or rejection
 * the verifier threw out was recorded under that category but acted on as
 * nothing, so it reads as "other" here.
 */
export function recordedOutcome(d) {
  const c = d.category || "";
  if (MILESTONES.has(c) && d.verifyRan === true && d.verifyGenuine === false) return "other";
  return c;
}

/**
 * Judge one stored digest. Unlike the live poll, mails the regexes flagged are
 * read too: this is a check on the whole pipeline, and "regex said interview,
 * Jev says none" is exactly what an operator wants to see. Marketing is still
 * skipped with the live rules.
 * @returns {{kind:"skipped"|"ran"|"error", ...}}
 */
export async function judgeDigest(d, { triage = triageMail } = {}) {
  const rules = d.rulesCategory || d.category || "";
  const base = {
    subject: d.subject || "(no subject)",
    from: d.fromEmail || "",
    date: d.date || null,
    recorded: recordedOutcome(d),
    rules,
    // The verifier read the full body and called it real. Jev here sees only
    // the preview, so it does not get to overrule that.
    verified: d.verifyRan === true && d.verifyGenuine === true
  };

  const body = [d.snippet, d.summary].filter(Boolean).join("\n").trim();
  const mail = { from: d.from || d.fromEmail || "", subject: d.subject || "", bodyText: body, snippet: d.snippet || "", rulesCategory: rules };
  const skip = MILESTONES.has(rules) ? "" : triageSkipReason(mail);
  if (skip) return { ...base, kind: "skipped", why: skip };

  const t = await triage(mail);
  if (!t.ok) return { ...base, kind: "error", why: t.error || "unknown" };
  return {
    ...base,
    kind: "ran",
    engine: triageEngine(t.model),
    category: t.category,
    confidence: t.confidence,
    reason: t.reason || "",
    found: triageFlags(t)
  };
}

/**
 * Worth an operator's eye: Jev found a hiring step the pipeline did not record,
 * the pipeline recorded one Jev does not see (unless the full-body verifier
 * confirmed it: rejections often say "unfortunately" past the stored preview),
 * or the call failed.
 */
export function isFinding(r) {
  if (r.kind === "error") return true;
  if (r.kind !== "ran") return false;
  const recordedMilestone = MILESTONES.has(r.recorded);
  if (r.found && r.category !== r.recorded) return true;
  if (recordedMilestone && r.category === "none" && !r.verified) return true;
  return false;
}

export function backfillTotals(results) {
  const t = { mails: results.length, skipped: 0, jev: 0, fallback: 0, errors: 0, found: 0, agree: 0, findings: 0 };
  for (const r of results) {
    if (r.kind === "skipped") t.skipped++;
    else if (r.kind === "error") t.errors++;
    else {
      if (r.engine === "jev") t.jev++;
      else t.fallback++;
      if (r.found) t.found++;
    }
    if (isFinding(r)) t.findings++;
    else if (r.kind === "ran") t.agree++;
  }
  return t;
}

const md = (s) => String(s ?? "").replace(/([\\`*_~|>])/g, "\\$1").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (d) => {
  const t = d ? new Date(d) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : "";
};
/** Characters Discord counts toward the 6000 per message. */
export function embedSize(e) {
  let n = (e.title || "").length + (e.description || "").length + (e.footer?.text || "").length;
  for (const f of e.fields || []) n += (f.name || "").length + (f.value || "").length;
  return n;
}
const scoreOf = (reason) => (/\(([\d.]+)\)/.exec(reason || "") || [])[1] || "";

function findingLine(r) {
  if (r.kind === "error") return `🔴 ${md(clip(r.subject, 90))}\n↳ ${md(r.from)} · ${day(r.date)} · AI failed: ${md(clip(r.why, 80))}`;
  const s = scoreOf(r.reason);
  const who = r.engine === "jev" ? "Jev" : "fallback model";
  const icon = r.found ? "🟢" : "🟡";
  return (
    `${icon} ${md(clip(r.subject, 90))}\n` +
    `↳ ${md(r.from)} · ${day(r.date)} · recorded: **${md(r.recorded) || "-"}** · ${who}: **${md(r.category)}**${s ? ` ${s}` : ""}`
  );
}

/**
 * Discord messages for one backfill: a summary embed, then the findings packed
 * into as few embeds as fit. Returns an array of message payloads.
 */
export function buildBackfillMessages({ client = {}, clientEmail = "", results = [], requestedBy = "", now = new Date() }) {
  const tot = backfillTotals(results);
  const who = client.name || clientEmail || "Client";
  const dates = results.map((r) => day(r.date)).filter(Boolean).sort();
  const span = dates.length ? `${dates[0]} to ${dates[dates.length - 1]}` : "-";
  const summary = {
    title: clip(`🔎 Jev on previous mails: ${who}`, 250),
    color: tot.findings ? 0xf59e0b : 0x22c55e,
    description:
      `Jev re-read ${tot.mails} stored mails (${span}). Read-only: no client email, no card moved.\n` +
      `Old mail is judged on sender, subject and the stored preview, because full bodies are not kept.\n\n` +
      (tot.findings
        ? `**${tot.findings}** worth a look below: 🟢 Jev found a hiring step the pipeline did not record, 🟡 the pipeline recorded one Jev does not see, 🔴 the call failed.`
        : "Jev agrees with everything the pipeline recorded."),
    fields: [
      { name: "Client", value: md(clientEmail) || "-", inline: false },
      { name: "Read by Jev", value: String(tot.jev), inline: true },
      { name: "Jev found", value: String(tot.found), inline: true },
      { name: "Agrees", value: String(tot.agree), inline: true },
      { name: "Skipped (promo)", value: String(tot.skipped), inline: true },
      { name: "Mails", value: String(tot.mails), inline: true },
      { name: "Fallback / errors", value: `${tot.fallback} / ${tot.errors}`, inline: true }
    ],
    footer: { text: `FlashFire • Jev watch backfill${requestedBy ? ` • run by ${clip(requestedBy, 60)}` : ""}` },
    timestamp: new Date(now).toISOString()
  };

  // Discord caps a message at 10 embeds AND 6000 characters across all of
  // them, so findings are packed by size, not by count.
  const chunks = [];
  let buf = [];
  let used = 0;
  for (const r of results.filter(isFinding)) {
    const line = findingLine(r);
    if (buf.length && used + line.length + 2 > DESCRIPTION_BUDGET) {
      chunks.push(buf);
      buf = [];
      used = 0;
    }
    buf.push(line);
    used += line.length + 2;
  }
  if (buf.length) chunks.push(buf);

  const messages = [[summary]];
  let size = embedSize(summary);
  let dropped = 0;
  for (const lines of chunks) {
    const embed = { color: 0xf59e0b, description: lines.join("\n\n") };
    const n = embedSize(embed);
    const current = messages[messages.length - 1];
    if (current.length < EMBEDS_PER_MESSAGE && size + n <= MESSAGE_BUDGET) {
      current.push(embed);
      size += n;
    } else if (messages.length < MAX_MESSAGES) {
      messages.push([embed]);
      size = n;
    } else {
      dropped += lines.length;
    }
  }
  if (dropped) {
    const last = messages[messages.length - 1];
    const tail = last[last.length - 1];
    tail.description = `${tail.description}\n\n…and ${dropped} more not shown`;
  }
  return messages;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const DIGEST_FIELDS =
  "subject from fromEmail snippet summary date category rulesCategory verifyRan verifyGenuine";

/** How many stored mails this client has (what the button will read). */
export async function countBackfillMails(clientEmail) {
  return MailDigest.countDocuments({ ownerEmail: String(clientEmail || "").toLowerCase().trim() });
}

/**
 * Run the backfill. Resolves when every mail is judged and Discord has the
 * result. Never throws; failures are logged and returned.
 */
export async function runJevBackfill(
  { clientEmail, client = {}, limit, requestedBy = "" },
  { triage = triageMail, post = notifyJevWatchMessage, findDigests = defaultFindDigests } = {}
) {
  const email = String(clientEmail || "").toLowerCase().trim();
  if (!email) return { ok: false, error: "clientEmail required" };
  if (running.has(email)) return { ok: false, error: "already_running" };
  running.add(email);
  const started = Date.now();
  try {
    const digests = await findDigests(email, backfillLimit(limit));
    const results = await mapLimit(digests, CONCURRENCY, (d) =>
      judgeDigest(d, { triage }).catch((e) => ({ subject: d.subject || "", from: d.fromEmail || "", date: d.date, recorded: d.category || "", kind: "error", why: e?.message || String(e) }))
    );
    const messages = buildBackfillMessages({ client, clientEmail: email, results, requestedBy });
    let posted = 0;
    for (const embeds of messages) {
      const res = await post(embeds);
      if (!res?.ok) {
        console.warn(`[jev-backfill] ${email}: Discord post failed: ${res?.error}`);
        break;
      }
      posted++;
    }
    const totals = backfillTotals(results);
    console.log(
      `[jev-backfill] ${email}: ${totals.mails} mails, jev=${totals.jev} found=${totals.found} findings=${totals.findings} in ${Math.round((Date.now() - started) / 1000)}s, posted ${posted}/${messages.length}`
    );
    return { ok: posted === messages.length, totals, posted };
  } catch (err) {
    console.warn(`[jev-backfill] ${email}: ${err?.message || err}`);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    running.delete(email);
  }
}

async function defaultFindDigests(email, limit) {
  return MailDigest.find({ ownerEmail: email }).sort({ date: -1 }).limit(limit).select(DIGEST_FIELDS).lean();
}

async function notifyJevWatchMessage(embeds) {
  return notifyJevWatch(embeds);
}

export const __testables = { mapLimit, findingLine, md };
