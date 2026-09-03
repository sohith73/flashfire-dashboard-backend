// Discord delivery for the hourly Gmail → AI → Discord pipeline.
//
// Two entry points:
//   • notifyMailDigest()   — one rich embed per new mail: client info, the
//     gpt-4o-mini summary, extracted links, and the .txt attachment uploaded
//     as a real Discord file.
//   • notifyGmailAuthError() — loud red alert when a client's Gmail refresh
//     token stops working (invalid_grant / revoked), telling ops to reconnect.
//
// Both swallow their own errors and return a result object. A Discord outage
// must never break the poll worker; undelivered digests are retried next tick
// because MailDigest.discordPostedAt stays null.
//
// ONE channel handles everything mail-related: per-mail digests, milestone
// reminders, "please connect your mail" nudges, dead-token alerts, and the
// daily 5am summary. Hard-coded here (per request) so it works with no env;
// ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS can override it for rotation.
const MAIL_WEBHOOK =
  process.env.ONE_MAIN_DISCORD_FOR_MAIL_NOTIFICATIONS ||
  "https://discord.com/api/webhooks/1535172893590294579/hJQzqUbV_vmreWWdQrNoXS3Z3tMTqMIxZeZ9i9LmHVpewgGyxb858MBb0TIbgNyH7Em7";
const ERROR_WEBHOOK = MAIL_WEBHOOK;

// Deep link shown in connect / reconnect alerts.
const RECONNECT_URL = "https://portal.flashfirejobs.com/inbox";

/** The single mail-notifications webhook. */
export function mailNotifyWebhook() {
  return MAIL_WEBHOOK;
}

/**
 * Confirm the webhook is valid + reachable WITHOUT posting a message: a GET on a
 * Discord webhook returns its object (200), no message sent. Used by the health route.
 * @returns {Promise<{ok: boolean, channelId?: string|null, status?: number, error?: string}>}
 */
export async function verifyWebhook() {
  if (!MAIL_WEBHOOK) return { ok: false, error: "no_webhook_configured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(MAIL_WEBHOOK, { method: "GET", signal: ctrl.signal });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: true, channelId: j.channel_id || null };
    }
    return { ok: false, status: res.status, error: `discord_http_${res.status}` };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timed_out" : String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const ALERT_MENTION = ""; // no role ping
// Discord's per-message upload ceiling for non-boosted guilds is 8 MiB; stay
// under it with margin for the multipart envelope + payload_json.
const MAX_UPLOAD_BYTES = 7_500_000;
const MAX_FILES = 10;
const POST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;

// ─── Discord field/embed length caps ────────────────────────────────
const LIMIT = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25 };

function truncate(value, max, suffix = "…") {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

// Discord renders <t:epoch:R> as a live "2 hours ago" that respects the
// viewer's timezone — better than baking IST into the string.
function discordTimestamp(date, style = "f") {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

const PRIORITY_COLOR = {
  high: 0xef4444,   // red
  medium: 0xf59e0b, // amber
  low: 0x3b82f6     // blue
};

// ─── Auth-error detection ───────────────────────────────────────────
//
// Only a *broken Google connection* should raise the red "reconnect" alert.
// This is easy to get wrong: Gmail answers BOTH "your token is dead" and
// "you're over quota" with HTTP 403, so matching on the status code alone
// would page ops to reconnect a perfectly healthy mailbox every time we hit a
// rate limit. Transient patterns are therefore checked first and always win.

// Status codes are only trusted when they appear in a status-bearing shape
// ("http=403", "status: 429", "401 Unauthorized") — never as a bare number,
// which would let a byte count or an id in an error string flip the verdict.
const status = (code) =>
  new RegExp(`(?:\\bhttp\\b|\\bstatus\\b|\\bcode\\b)\\s*[=:]?\\s*${code}\\b`, "i");

// Retryable — Gmail is fine, we just backed off or the network blipped.
const TRANSIENT_PATTERNS = [
  /rateLimitExceeded/i,
  /userRateLimitExceeded/i,
  /dailyLimitExceeded/i,
  /quotaExceeded/i,
  /backendError/i,
  /\binternal error\b/i,
  status("429"),
  /\b429\s+too many requests\b/i,
  status("5\\d{2}"),
  /\b5\d{2}\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /\baborted\b/i,
  /timed out/i
];

// The refresh token is dead / scopes were withdrawn. A human must reconnect.
// Note 403 is deliberately absent: Gmail uses it for quota AND for permission,
// so only the explicit permission reasons above qualify.
const AUTH_ERROR_PATTERNS = [
  /invalid_grant/i,
  /token has been expired or revoked/i,
  /invalid_client/i,
  /unauthorized_client/i,
  /\binvalid_request\b/i,
  /insufficient.*(permission|scope)/i,
  /insufficientPermissions/i,
  /invalid credentials/i,
  /invalid authentication credentials/i,
  /login required/i,
  /missing required authentication/i,
  status("401"),
  /\b401\s+unauthorized\b/i
];

export function isGmailAuthError(msg = "") {
  const s = String(msg || "");
  if (!s) return false;
  // A quota 403 must never masquerade as a dead token.
  if (TRANSIENT_PATTERNS.some((re) => re.test(s))) return false;
  return AUTH_ERROR_PATTERNS.some((re) => re.test(s));
}

/**
 * Flatten a googleapis/Gaxios error into one searchable string.
 * The useful signal is split across err.message and err.response.data
 * ({ error, error_description } for OAuth, { error: { message, errors } } for
 * the Gmail REST API), so classify on the concatenation, never on one field.
 */
export function errorText(err) {
  if (!err) return "";
  const parts = [];
  if (err.message) parts.push(String(err.message));
  if (err.code !== undefined && err.code !== null) parts.push(`code=${err.code}`);
  if (err.status) parts.push(`status=${err.status}`);

  const data = err.response?.data;
  if (typeof data === "string") {
    parts.push(data);
  } else if (data && typeof data === "object") {
    if (data.error_description) parts.push(String(data.error_description));
    if (typeof data.error === "string") parts.push(data.error);
    else if (data.error && typeof data.error === "object") {
      if (data.error.message) parts.push(String(data.error.message));
      for (const e of data.error.errors || []) {
        if (e?.reason) parts.push(String(e.reason));
        if (e?.message) parts.push(String(e.message));
      }
    }
  }
  const status = err.response?.status;
  if (status) parts.push(`http=${status}`);

  return [...new Set(parts)].filter(Boolean).join(" | ");
}

// ─── Transport ──────────────────────────────────────────────────────

// postToWebhook: JSON when there are no files, multipart/form-data when there
// are. Retries on 429 (honouring retry_after) and 5xx, with a hard attempt cap.
async function postToWebhook(webhookUrl, payload, files = []) {
  if (!webhookUrl) {
    return { ok: false, error: "webhook_not_configured" };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    try {
      let body;
      const headers = {};

      if (files.length) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        files.forEach((f, i) => {
          form.append(
            `files[${i}]`,
            new Blob([f.buffer], { type: f.contentType || "application/octet-stream" }),
            f.filename || `file-${i}`
          );
        });
        body = form; // fetch sets the multipart boundary itself
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(payload);
      }

      const res = await fetch(webhookUrl, { method: "POST", headers, body, signal: ctrl.signal });

      if (res.ok) return { ok: true, status: res.status };

      // Rate limited — Discord tells us exactly how long to wait.
      if (res.status === 429) {
        const info = await res.json().catch(() => ({}));
        const waitMs = Math.min(10_000, Math.ceil((Number(info.retry_after) || 1) * 1000));
        console.warn(`[MailDiscord] rate limited, retrying in ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // 5xx is worth retrying; 4xx (bad embed, unknown webhook) is not.
      const text = await res.text().catch(() => "");
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return { ok: false, error: `discord_http_${res.status}: ${text.slice(0, 300)}` };
    } catch (e) {
      const msg = e?.name === "AbortError" ? `timed out after ${POST_TIMEOUT_MS}ms` : e?.message || String(e);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return { ok: false, error: `discord_post_failed: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "discord_retries_exhausted" };
}

// ─── Attachment selection ───────────────────────────────────────────

// pickUploadable: keep files under the per-message ceiling, largest-first
// rejection. Returns { files, skipped } so the embed can say what was dropped
// instead of silently losing it.
function pickUploadable(candidates = []) {
  const files = [];
  const skipped = [];
  let total = 0;
  for (const c of candidates) {
    const size = c.buffer?.length || 0;
    if (files.length >= MAX_FILES) {
      skipped.push({ filename: c.filename, reason: `max ${MAX_FILES} files per message` });
      continue;
    }
    if (size > MAX_UPLOAD_BYTES || total + size > MAX_UPLOAD_BYTES) {
      skipped.push({ filename: c.filename, reason: `${(size / 1024 / 1024).toFixed(1)} MB exceeds upload limit` });
      continue;
    }
    total += size;
    files.push(c);
  }
  return { files, skipped };
}

// ─── Public: per-mail digest ────────────────────────────────────────

/**
 * Post one mail to Discord as a rich embed, uploading its text attachments.
 *
 * @param {Object} a
 * @param {Object} a.client   - { name, email, planType, dashboardManager }
 * @param {string} a.mailbox  - the connected Gmail address the mail landed in
 * @param {Object} a.digest   - MailDigest-shaped: subject, from, date, summary,
 *                              keyPoints, urls, category, priority,
 *                              actionRequired, aiSucceeded, snippet, attachments
 * @param {Array}  [a.files]  - [{ filename, contentType, buffer }]
 * @param {Object} [a.counts] - { totalForClient, newThisRun }
 * @returns {Promise<{ok: boolean, error?: string, skipped?: Array}>}
 */
export async function notifyMailDigest({ client = {}, mailbox, digest = {}, files = [], counts = {} }) {
  const { files: uploadable, skipped } = pickUploadable(files);

  const clientName = client.name || client.email || mailbox || "Unknown client";
  const priority = PRIORITY_COLOR[digest.priority] ? digest.priority : "low";

  const fields = [];

  // Who the mail is about — the "proper client info" block.
  const clientLines = [
    `**Name:** ${client.name || "—"}`,
    `**Account:** ${client.email || "—"}`,
    `**Plan:** ${client.planType || "—"}`
  ];
  if (client.dashboardManager) clientLines.push(`**Manager:** ${client.dashboardManager}`);
  fields.push({
    name: "👤 Client",
    value: truncate(clientLines.join("\n"), LIMIT.fieldValue),
    inline: true
  });

  const totalForClient = Number(counts.totalForClient || 0);
  const newThisRun = Number(counts.newThisRun || 0);
  fields.push({
    name: "📊 Mail count",
    value: truncate(
      [
        `**This run:** ${newThisRun} new`,
        `**Lifetime:** ${totalForClient} mail${totalForClient === 1 ? "" : "s"}`,
        `**Mailbox:** ${mailbox || "—"}`
      ].join("\n"),
      LIMIT.fieldValue
    ),
    inline: true
  });

  fields.push({
    name: "✉️ From",
    value: truncate(digest.from || digest.fromEmail || "—", LIMIT.fieldValue),
    inline: false
  });

  fields.push({
    name: "🕒 Received",
    value: `${discordTimestamp(digest.date)} · ${discordTimestamp(digest.date, "R")}`,
    inline: true
  });
  fields.push({
    name: "🏷️ Category",
    value: truncate(`${digest.category || "other"} · ${priority} priority`, LIMIT.fieldValue),
    inline: true
  });

  if (Array.isArray(digest.keyPoints) && digest.keyPoints.length) {
    fields.push({
      name: "🔑 Key points",
      value: truncate(digest.keyPoints.map((k) => `• ${k}`).join("\n"), LIMIT.fieldValue),
      inline: false
    });
  }

  if (digest.actionRequired) {
    fields.push({
      name: "➡️ Action required",
      value: truncate(digest.actionRequired, LIMIT.fieldValue),
      inline: false
    });
  }

  if (Array.isArray(digest.urls) && digest.urls.length) {
    // Keep adding links until the 1024-char field cap would be breached.
    const shown = [];
    let len = 0;
    for (const u of digest.urls) {
      const line = `• ${u}`;
      if (len + line.length + 1 > LIMIT.fieldValue - 40) break;
      shown.push(line);
      len += line.length + 1;
    }
    const hidden = digest.urls.length - shown.length;
    fields.push({
      name: `🔗 Links (${digest.urls.length})`,
      value: truncate(shown.join("\n") + (hidden > 0 ? `\n…and ${hidden} more` : ""), LIMIT.fieldValue),
      inline: false
    });
  }

  const attachNote = [];
  for (const f of uploadable) attachNote.push(`📎 ${f.filename} (${(f.buffer.length / 1024).toFixed(1)} KB) — attached below`);
  for (const s of skipped) attachNote.push(`⚠️ ${s.filename} — not uploaded: ${s.reason}`);
  if (attachNote.length) {
    fields.push({
      name: "Attachments",
      value: truncate(attachNote.join("\n"), LIMIT.fieldValue),
      inline: false
    });
  }

  if (!digest.aiSucceeded) {
    fields.push({
      name: "⚠️ AI summary unavailable",
      value: truncate(`Falling back to the raw mail snippet. ${digest.aiError || ""}`.trim(), LIMIT.fieldValue),
      inline: false
    });
  }

  const description = digest.summary || digest.snippet || "_No content extracted from this mail._";

  const embed = {
    title: truncate(`📬 ${digest.subject || "(no subject)"}`, LIMIT.title),
    // Clicking the title opens the primary link from the mail, when there is one.
    ...(digest.urls?.[0] ? { url: digest.urls[0] } : {}),
    color: PRIORITY_COLOR[priority],
    author: { name: truncate(clientName, LIMIT.title) },
    description: truncate(description, LIMIT.description),
    fields: fields.slice(0, LIMIT.fields),
    timestamp: digest.date ? new Date(digest.date).toISOString() : new Date().toISOString(),
    footer: { text: truncate(`FlashFire • Mail AI • ${digest.aiModel || "gpt-4o-mini"}`, LIMIT.fieldName) }
  };

  const result = await postToWebhook(MAIL_WEBHOOK, { embeds: [embed], allowed_mentions: { parse: [] } }, uploadable);
  return { ...result, skipped };
}

// ─── Public: Gmail auth failure ─────────────────────────────────────

/**
 * Red alert when a client's Gmail token can no longer authenticate.
 * Throttling is the caller's job (GmailPollState.lastAuthAlertAt) so the
 * throttle survives restarts.
 *
 * @param {Object} a
 * @param {Object} a.client  - { name, email, planType }
 * @param {string} a.mailbox - the Gmail address that failed
 * @param {string} a.error   - raw error text (e.g. "invalid_grant")
 * @param {Date}   [a.since] - when the account first started failing
 */
export async function notifyGmailAuthError({ client = {}, mailbox, error, since } = {}) {
  const reconnectUrl = RECONNECT_URL;

  const fields = [
    {
      name: "👤 Client",
      value: truncate(
        [
          `**Name:** ${client.name || "—"}`,
          `**Account:** ${client.email || "—"}`,
          `**Plan:** ${client.planType || "—"}`
        ].join("\n"),
        LIMIT.fieldValue
      ),
      inline: true
    },
    {
      name: "📥 Mailbox",
      value: truncate(mailbox || "unknown", LIMIT.fieldValue),
      inline: true
    },
    {
      name: "Error",
      value: truncate("```" + String(error || "unknown").slice(0, 900) + "```", LIMIT.fieldValue),
      inline: false
    }
  ];

  if (since) {
    fields.push({ name: "Failing since", value: discordTimestamp(since, "R"), inline: true });
  }

  fields.push({
    name: "➡️ Action needed",
    value: truncate(
      "The Google refresh token for this mailbox is dead — Gmail polling and the Mails tab are **both** down for this client.\n\n" +
        "**Fix:** Dashboard → **Inbox** → Google account → **Reconnect**, then re-grant access." +
        (reconnectUrl ? `\n\n[Reconnect now](${reconnectUrl}?email=${encodeURIComponent(client.email || "")})` : ""),
      LIMIT.fieldValue
    ),
    inline: false
  });

  const embed = {
    title: "🔐 Gmail authorization error — please reconnect the mail",
    color: 0xef4444,
    description: `No mail can be read for **${client.name || mailbox || "this client"}** until the Google account is reconnected.`,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "FlashFire • Mail • connection" }
  };

  const payload = {
    ...(ALERT_MENTION ? { content: ALERT_MENTION } : {}),
    embeds: [embed],
    allowed_mentions: ALERT_MENTION ? { parse: ["roles", "users"] } : { parse: [] }
  };

  return postToWebhook(ERROR_WEBHOOK, payload);
}

// ─── Public: "connect your mail" nudge ──────────────────────────────

/**
 * Nudge for an active client whose mail is not connected, or whose token died.
 * Throttling (once/day/client) is the caller's job.
 *
 * @param {Object} a
 * @param {Object} a.client - { name, email }
 * @param {"not_connected"|"token_dead"} a.kind
 * @param {string} [a.reconnectUrl]
 */
export async function notifyClientNotConnected({ client = {}, kind = "not_connected", reconnectUrl } = {}) {
  const url = reconnectUrl || RECONNECT_URL;
  const who = client.name || client.email || "This client";
  const isDead = kind === "token_dead";

  const embed = {
    title: isDead ? "🔌 Mail disconnected — please reconnect" : "📭 No mail connected — please connect",
    color: isDead ? 0xf59e0b : 0x6366f1, // amber / indigo
    description: isDead
      ? `**${who}** had mail connected, but the Google token is no longer valid. We can't read their inbox until it's reconnected.`
      : `**${who}** is active but has **no mail connected**. Please connect their Gmail so we can watch for interviews, assignments, and offers.`,
    fields: [
      { name: "Client", value: truncate(client.name || "—", LIMIT.fieldValue), inline: true },
      { name: "Account", value: truncate(client.email || "—", LIMIT.fieldValue), inline: true },
      {
        name: "➡️ Action",
        value: truncate(
          "Dashboard → **Inbox** → connect / reconnect the client's Google account." +
            (url ? `\n\n[Open Inbox](${url})` : ""),
          LIMIT.fieldValue
        ),
        inline: false
      }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "FlashFire • Mail • connection check" }
  };

  return postToWebhook(MAIL_WEBHOOK, { embeds: [embed], allowed_mentions: { parse: [] } });
}

// ─── Public: daily 5am summary ──────────────────────────────────────

/**
 * Header message for the daily summary. Sent once, then followed by one
 * per-useful-mail message via notifyUsefulMailLine().
 *
 * @param {Object} a - { scannedClients, connectedMailboxes, notConnected,
 *                        totalMails, usefulMails, windowHours, dateLabel }
 */
export async function notifyDailySummaryHeader(a = {}) {
  const useful = Number(a.usefulMails || 0);
  const embed = {
    title: "📊 Daily Mail Summary",
    color: useful > 0 ? 0x22c55e : 0x3b82f6, // green if there's good news, else blue
    description: a.dateLabel ? `Window: last ${a.windowHours || 24}h · ${a.dateLabel}` : `Last ${a.windowHours || 24} hours`,
    fields: [
      { name: "Active clients scanned", value: String(a.scannedClients ?? 0), inline: true },
      { name: "Mailboxes connected", value: String(a.connectedMailboxes ?? 0), inline: true },
      { name: "Not connected", value: String(a.notConnected ?? 0), inline: true },
      { name: "📥 Mails seen", value: String(a.totalMails ?? 0), inline: true },
      { name: "⭐ Useful (interview / assignment / offer)", value: String(useful), inline: true }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "FlashFire • Mail • daily 5 AM IST" }
  };
  if (useful === 0) {
    embed.fields.push({ name: "Result", value: "No useful mails in this window. Detail messages follow only when there are.", inline: false });
  } else {
    embed.fields.push({ name: "Result", value: `${useful} useful mail(s) — one message each follows. ⬇️`, inline: false });
  }
  return postToWebhook(MAIL_WEBHOOK, { embeds: [embed], allowed_mentions: { parse: [] } });
}

const USEFUL_META = {
  interview: { emoji: "🎉", label: "Interview", color: 0x7c3aed },
  assessment: { emoji: "📝", label: "Assignment", color: 0x0891b2 },
  offer: { emoji: "🏆", label: "Offer", color: 0x16a34a }
};

/**
 * One message per useful mail: "Client (Name) got: <subject> — received <time>".
 *
 * @param {Object} a - { clientName, clientEmail, category, subject, from, receivedAt }
 */
export async function notifyUsefulMailLine(a = {}) {
  const meta = USEFUL_META[a.category] || { emoji: "⭐", label: "Useful", color: 0x22c55e };
  const embed = {
    title: `${meta.emoji} ${meta.label} — ${truncate(a.clientName || a.clientEmail || "Client", 80)}`,
    color: meta.color,
    description: truncate(`**${a.clientName || a.clientEmail || "A client"}** got: **${a.subject || "(no subject)"}**`, LIMIT.description),
    fields: [
      { name: "From", value: truncate(a.from || "—", LIMIT.fieldValue), inline: false },
      {
        name: "Received",
        value: a.receivedAt ? `${discordTimestamp(a.receivedAt)} · ${discordTimestamp(a.receivedAt, "R")}` : "—",
        inline: true
      }
    ],
    timestamp: a.receivedAt ? new Date(a.receivedAt).toISOString() : new Date().toISOString(),
    footer: { text: "FlashFire • Mail update" }
  };
  return postToWebhook(MAIL_WEBHOOK, { embeds: [embed], allowed_mentions: { parse: [] } });
}

export const __testables = { truncate, pickUploadable, discordTimestamp };
