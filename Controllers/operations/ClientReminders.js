// Operator-facing HTTP surface for the "Client Reminders" tab.
//
// Everything here is read/write of ONE ClientReminderConfig document plus a
// couple of read-only lookups (payment email, activity counters). The actual
// delivery logic lives in src/services/clientReminderWorker.js and is shared
// verbatim between the cron and the operator's "Send now" button, so a preview
// or a manual send can never diverge from what the schedule will produce.
//
// Every route in this file sits behind Middlewares/RequireOpsKey.js.

import {
  ClientReminderConfig,
  mergeWithDefaults,
  sanitizeItemsInput,
  getCurrentISTTime
} from "../../Schema_Models/ClientReminderConfig.js";
import {
  REMINDER_ITEMS,
  isReminderItemKey,
  reminderItemMeta
} from "../../Utils/reminderItems.js";
import { ClientPaymentLookup, resolvePaymentEmail } from "../../Schema_Models/ClientPaymentLookup.js";
import { isSmtpConfigured } from "../../Utils/smtpSender.js";
import {
  normalizeWebhookUrl,
  isValidWebhookUrl,
  sendToMattermost
} from "../../Utils/mattermostSender.js";
import { renderReminderEmail, renderReminderMattermost } from "../../Utils/reminderTemplates.js";
import {
  getClientActivityStats,
  getClientLifetimeStats,
  daysSinceLastActivity,
  startOfCalendarDayIST,
  endOfCalendarDayIST
} from "../../Utils/clientActivityStats.js";

const LOG_PREFIX = "[clientReminders]";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_RETURN = 50;

/**
 * The worker module is imported LAZILY, inside each handler that needs it.
 *
 * Two reasons, both real:
 *   1. Circular import safety. The worker imports the model and the templates;
 *      if it ever grows an import of this controller (a shared helper, a
 *      status endpoint) a top-level import here would produce a half-populated
 *      module object at load time. A dynamic import inside the handler resolves
 *      after both modules have finished evaluating.
 *   2. Load independence. Routes.js pulls this controller in at boot. If the
 *      worker file is mid-edit, missing, or throws on evaluation, the whole
 *      backend must still start — the reminder routes degrade to a 503 rather
 *      than taking the process down.
 */
async function loadWorker() {
  try {
    return await import("../../src/services/clientReminderWorker.js");
  } catch (err) {
    console.error(`${LOG_PREFIX} reminder worker module failed to load:`, err?.message || err);
    return null;
  }
}

/**
 * Mirrors the worker's own ENABLED gate so the UI can tell the operator
 * whether the cron will actually fire, without importing the worker just to
 * read a boolean. Keep the two in step: '1' forces on, '0' forces off,
 * otherwise it follows Render (production) like every other worker here.
 */
function reminderWorkerEnabled() {
  const raw = String(process.env.CLIENT_REMINDERS_ENABLED ?? "").trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return Boolean(process.env.RENDER);
}

/** Pull + validate clientEmail. Returns "" and answers 400 when unusable. */
function readClientEmail(req, res) {
  const raw = String(req?.body?.clientEmail || "").trim().toLowerCase();
  if (!raw) {
    res.status(400).json({ success: false, message: "clientEmail is required" });
    return "";
  }
  if (!EMAIL_RE.test(raw)) {
    res.status(400).json({ success: false, message: "clientEmail is not a valid email address" });
    return "";
  }
  return raw;
}

function fail(res, err, where, message) {
  // Log the whole thing server-side, hand the caller a sentence. Stack traces
  // in an API response are a gift to anyone probing the endpoint.
  console.error(`${LOG_PREFIX} ${where} failed:`, err?.stack || err?.message || err);
  return res.status(500).json({ success: false, message });
}

/**
 * Where a client's reminder email actually goes.
 *
 * dashboardtrackings wins whenever it has an answer — it is owned by the
 * applications-monitor backend and is what finance already maintains. The
 * per-config override exists only for clients that have no tracking doc at all.
 */
async function resolveDestinationEmail(clientEmail, config) {
  let tracking = { paymentEmail: "", matched: false, clientName: "" };
  try {
    tracking = await resolvePaymentEmail(clientEmail);
  } catch (err) {
    console.error(`${LOG_PREFIX} resolvePaymentEmail failed for ${clientEmail}:`, err?.message || err);
  }

  if (tracking.paymentEmail) {
    return {
      resolvedPaymentEmail: tracking.paymentEmail,
      paymentEmailSource: "tracking",
      trackingMatched: tracking.matched === true,
      clientName: tracking.clientName || ""
    };
  }

  const override = String(config?.paymentEmailOverride || "").trim().toLowerCase();
  if (EMAIL_RE.test(override)) {
    return {
      resolvedPaymentEmail: override,
      paymentEmailSource: "override",
      trackingMatched: tracking.matched === true,
      clientName: tracking.clientName || ""
    };
  }

  return {
    resolvedPaymentEmail: "",
    paymentEmailSource: "none",
    trackingMatched: tracking.matched === true,
    clientName: tracking.clientName || ""
  };
}

/** Read a config without creating one. Returns merged defaults for a new client. */
async function readConfig(clientEmail) {
  const doc = await ClientReminderConfig.findOne({ clientEmail }).lean();
  const merged = mergeWithDefaults(doc);
  merged.clientEmail = clientEmail;
  return { doc, merged };
}

/**
 * Read a config, creating it with catalogue defaults when it does not exist.
 * Only the write paths use this — send-now and test both need a document to
 * append history to, whereas the GET route must stay side-effect free.
 */
async function readOrCreateConfig(clientEmail, updatedBy = "") {
  const now = getCurrentISTTime();
  const doc = await ClientReminderConfig.findOneAndUpdate(
    { clientEmail },
    {
      $setOnInsert: {
        clientEmail,
        clientName: "",
        // Off until an operator opts this client in. See the field comment in
        // the schema for why this one in particular must never default on.
        inboxAlertsEnabled: false,
        paymentEmailOverride: "",
        mattermostWebhookUrl: "",
        items: mergeWithDefaults(null).items,
        history: [],
        updatedBy: String(updatedBy || ""),
        createdAt: now,
        updatedAt: now
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  const merged = mergeWithDefaults(doc);
  merged.clientEmail = clientEmail;
  return { doc, merged };
}

/** Today and the trailing seven IST days, as the tab's at-a-glance numbers. */
async function activityPreview(clientEmail) {
  const now = new Date();
  const todayFrom = startOfCalendarDayIST(now);
  const todayTo = endOfCalendarDayIST(now);
  const weekFrom = startOfCalendarDayIST(new Date(todayFrom.getTime() - 6 * DAY_MS));

  const [today, week] = await Promise.all([
    getClientActivityStats(clientEmail, { from: todayFrom, to: todayTo }),
    getClientActivityStats(clientEmail, { from: weekFrom, to: todayTo })
  ]);

  return {
    today: { added: today.addedCount, applied: today.appliedCount },
    week: { added: week.addedCount, applied: week.appliedCount }
  };
}

/* ------------------------------------------------------------------ */
/* POST /operations/reminders/get                                      */
/* ------------------------------------------------------------------ */

export const getClientReminderConfig = async (req, res) => {
  const clientEmail = readClientEmail(req, res);
  if (!clientEmail) return undefined;

  try {
    const { merged } = await readConfig(clientEmail);
    const destination = await resolveDestinationEmail(clientEmail, merged);

    // Show the operator the tracked client name when the config has not been
    // saved with one yet, so the tab is not blank for an unconfigured client.
    if (!merged.clientName && destination.clientName) merged.clientName = destination.clientName;

    const preview = await activityPreview(clientEmail);

    return res.status(200).json({
      success: true,
      data: {
        config: merged,
        catalogue: REMINDER_ITEMS,
        resolvedPaymentEmail: destination.resolvedPaymentEmail,
        paymentEmailSource: destination.paymentEmailSource,
        trackingMatched: destination.trackingMatched,
        smtpConfigured: isSmtpConfigured(),
        workerEnabled: reminderWorkerEnabled(),
        preview
      }
    });
  } catch (err) {
    return fail(res, err, "getClientReminderConfig", "Failed to load reminder settings");
  }
};

/* ------------------------------------------------------------------ */
/* PUT /operations/reminders                                           */
/* ------------------------------------------------------------------ */

export const updateClientReminderConfig = async (req, res) => {
  const clientEmail = readClientEmail(req, res);
  if (!clientEmail) return undefined;

  try {
    const { mattermostWebhookUrl, items, updatedBy, clientName, inboxAlertsEnabled } = req.body || {};

    // ABSENT MEANS "LEAVE IT ALONE", and that distinction matters: a caller
    // that saves only one field (the inbox-alerts switch) must not blank the
    // webhook simply by not mentioning it. Storing normalizeWebhookUrl(undefined)
    // unconditionally erased a working credential on every partial save.
    const webhookProvided = mattermostWebhookUrl !== undefined;
    const webhook = webhookProvided ? normalizeWebhookUrl(mattermostWebhookUrl) : "";
    // An empty webhook is a legitimate state (email-only client). A non-empty
    // one that is not https is rejected loudly rather than silently stored and
    // then failing on every tick for weeks.
    if (webhook && !isValidWebhookUrl(webhook)) {
      return res.status(400).json({
        success: false,
        message: "mattermostWebhookUrl must be a valid https URL"
      });
    }

    const existing = await ClientReminderConfig.findOne({ clientEmail }).lean();
    const sanitized = sanitizeItemsInput(items, existing?.items || []);

    const now = getCurrentISTTime();
    const set = {
      items: sanitized,
      updatedBy: String(updatedBy || "").slice(0, 120),
      updatedAt: now
    };
    if (webhookProvided) set.mattermostWebhookUrl = webhook;
    if (clientName !== undefined) set.clientName = String(clientName || "").slice(0, 200);
    // Strict === true. A stray string must never read as "start forwarding this
    // client's inbox milestones to them".
    if (inboxAlertsEnabled !== undefined) set.inboxAlertsEnabled = inboxAlertsEnabled === true;

    const saved = await ClientReminderConfig.findOneAndUpdate(
      { clientEmail },
      { $set: set, $setOnInsert: { clientEmail, createdAt: now, history: [] } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const merged = mergeWithDefaults(saved);
    merged.clientEmail = clientEmail;

    return res.status(200).json({ success: true, data: { config: merged } });
  } catch (err) {
    return fail(res, err, "updateClientReminderConfig", "Failed to save reminder settings");
  }
};

/* ------------------------------------------------------------------ */
/* POST /operations/reminders/payment-email                            */
/* ------------------------------------------------------------------ */

export const setClientReminderPaymentEmail = async (req, res) => {
  const clientEmail = readClientEmail(req, res);
  if (!clientEmail) return undefined;

  try {
    const raw = String(req.body?.paymentEmail ?? "").trim().toLowerCase();
    // "" is an explicit clear, not an error. Anything else must look like an
    // address before we let it become a delivery destination.
    if (raw && !EMAIL_RE.test(raw)) {
      return res.status(400).json({ success: false, message: "paymentEmail is not a valid email address" });
    }

    const updatedBy = String(req.body?.updatedBy || "").slice(0, 120);

    // Match a tracking doc exactly the way resolvePaymentEmail does, so the
    // write lands on the same document the read will later find.
    const anyOf = [new RegExp(`^${clientEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")];
    const tracking = await ClientPaymentLookup.findOne({
      $or: [{ email: { $in: anyOf } }, { "gmailCredentials.email": { $in: anyOf } }]
    })
      .select("_id email name")
      .lean();

    if (tracking?._id) {
      await ClientPaymentLookup.updateOne({ _id: tracking._id }, { $set: { paymentEmail: raw } });
      // Clear any stale override so the two sources cannot disagree later.
      await ClientReminderConfig.updateOne(
        { clientEmail },
        { $set: { paymentEmailOverride: "", updatedBy, updatedAt: getCurrentISTTime() } }
      );
      return res.status(200).json({ success: true, paymentEmail: raw, source: "tracking" });
    }

    const now = getCurrentISTTime();
    await ClientReminderConfig.findOneAndUpdate(
      { clientEmail },
      {
        $set: { paymentEmailOverride: raw, updatedBy, updatedAt: now },
        $setOnInsert: {
          clientEmail,
          items: mergeWithDefaults(null).items,
          history: [],
          createdAt: now
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ success: true, paymentEmail: raw, source: "override" });
  } catch (err) {
    return fail(res, err, "setClientReminderPaymentEmail", "Failed to save the payment email");
  }
};

/* ------------------------------------------------------------------ */
/* POST /operations/reminders/send-now                                 */
/* ------------------------------------------------------------------ */

export const sendClientReminderNow = async (req, res) => {
  const clientEmail = readClientEmail(req, res);
  if (!clientEmail) return undefined;

  try {
    const itemKey = String(req.body?.itemKey || "").trim();
    if (!isReminderItemKey(itemKey)) {
      return res.status(400).json({ success: false, message: "itemKey is not a known reminder item" });
    }

    const worker = await loadWorker();
    if (!worker?.deliverReminder) {
      return res.status(503).json({ success: false, message: "Reminder delivery is temporarily unavailable" });
    }

    const updatedBy = String(req.body?.updatedBy || "").slice(0, 120);
    const { merged } = await readOrCreateConfig(clientEmail, updatedBy);

    // A channel override is only ever a narrowing of what the operator sees on
    // screen ("send just the Mattermost copy"). Absent means "use the item's
    // saved channels".
    const rawChannels = req.body?.channels;
    const channelsOverride =
      rawChannels && typeof rawChannels === "object"
        ? {
            mattermost: rawChannels.mattermost === true,
            email: rawChannels.email === true
          }
        : null;

    const result = await worker.deliverReminder({
      config: merged,
      itemKey,
      trigger: updatedBy ? `manual:${updatedBy}` : "manual",
      force: req.body?.force === true,
      channelsOverride,
      now: new Date()
    });

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return fail(res, err, "sendClientReminderNow", "Failed to send the reminder");
  }
};

/* ------------------------------------------------------------------ */
/* POST /operations/reminders/test-mattermost                          */
/* ------------------------------------------------------------------ */

export const testClientReminderMattermost = async (req, res) => {
  const clientEmail = readClientEmail(req, res);
  if (!clientEmail) return undefined;

  try {
    let webhook = normalizeWebhookUrl(req.body?.webhookUrl);
    if (!webhook) {
      // Falling back to the saved URL lets an operator re-test an existing
      // integration without pasting the secret back into the form.
      const { merged } = await readConfig(clientEmail);
      webhook = normalizeWebhookUrl(merged.mattermostWebhookUrl);
    }

    if (!isValidWebhookUrl(webhook)) {
      return res.status(400).json({
        success: false,
        ok: false,
        error: "No valid https Mattermost webhook URL to test"
      });
    }

    const result = await sendToMattermost({
      webhookUrl: webhook,
      text: [
        "#### FlashFire reminder channel test",
        "",
        `Connected for **${clientEmail}**. Scheduled reports will land here.`,
        "",
        `_Sent ${getCurrentISTTime()} IST_`
      ].join("\n"),
      username: "FlashFire",
      iconEmoji: "fire"
    });

    return res.status(200).json({
      success: true,
      ok: result.ok === true,
      ...(result.ok ? {} : { error: result.error || "delivery failed" })
    });
  } catch (err) {
    return fail(res, err, "testClientReminderMattermost", "Failed to test the Mattermost webhook");
  }
};

/* ------------------------------------------------------------------ */
/* POST /operations/reminders/preview                                  */
/* ------------------------------------------------------------------ */

export const previewClientReminder = async (req, res) => {
  const clientEmail = readClientEmail(req, res);
  if (!clientEmail) return undefined;

  try {
    const itemKey = String(req.body?.itemKey || "").trim();
    const meta = reminderItemMeta(itemKey);
    if (!meta) {
      return res.status(400).json({ success: false, message: "itemKey is not a known reminder item" });
    }

    // reportWindowFor comes from the worker on purpose. If the preview computed
    // its own window it would drift from the scheduled send the first time
    // anyone touched either definition, and the operator would be approving
    // copy the client never receives.
    const worker = await loadWorker();
    if (!worker?.reportWindowFor) {
      return res.status(503).json({ success: false, message: "Reminder preview is temporarily unavailable" });
    }

    const now = new Date();
    const windowSpec = worker.reportWindowFor(itemKey, now);
    const from = windowSpec?.from instanceof Date ? windowSpec.from : startOfCalendarDayIST(now);
    const to = windowSpec?.to instanceof Date ? windowSpec.to : endOfCalendarDayIST(now);
    const label = String(windowSpec?.label || "");

    const { merged } = await readConfig(clientEmail);
    const destination = await resolveDestinationEmail(clientEmail, merged);
    const clientName = merged.clientName || destination.clientName || "";

    const [stats, lifetime] = await Promise.all([
      getClientActivityStats(clientEmail, { from, to }),
      getClientLifetimeStats(clientEmail)
    ]);

    const extra = {};
    if (itemKey === "inactivity_alert") {
      const item = merged.items.find((i) => i.key === "inactivity_alert");
      const days = await daysSinceLastActivity(clientEmail, Math.max(item?.inactivityDays || 3, 30));
      extra.days = days;
    }

    const payload = {
      kind: itemKey,
      client: { name: clientName, email: clientEmail },
      stats,
      lifetime,
      period: { label, from, to },
      extra
    };

    const email = renderReminderEmail(payload);
    const mm = renderReminderMattermost(payload);

    if (!email && !mm) {
      return res.status(400).json({ success: false, message: "No template is registered for that item" });
    }

    return res.status(200).json({
      success: true,
      subject: email?.subject || "",
      html: email?.html || "",
      text: email?.text || "",
      mattermostText: mm?.text || "",
      isEmpty: stats.isEmpty === true,
      window: { from, to, label }
    });
  } catch (err) {
    return fail(res, err, "previewClientReminder", "Failed to build the reminder preview");
  }
};

/* ------------------------------------------------------------------ */
/* POST /operations/reminders/history                                  */
/* ------------------------------------------------------------------ */

export const getClientReminderHistory = async (req, res) => {
  const clientEmail = readClientEmail(req, res);
  if (!clientEmail) return undefined;

  try {
    const rawLimit = Number(req.body?.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_HISTORY_RETURN, Math.max(1, Math.floor(rawLimit)))
      : MAX_HISTORY_RETURN;

    const doc = await ClientReminderConfig.findOne({ clientEmail }).select("history").lean();
    const history = mergeWithDefaults({ history: doc?.history || [] }).history.slice(0, limit);

    return res.status(200).json({ success: true, history });
  } catch (err) {
    return fail(res, err, "getClientReminderHistory", "Failed to load reminder history");
  }
};

export default {
  getClientReminderConfig,
  updateClientReminderConfig,
  setClientReminderPaymentEmail,
  sendClientReminderNow,
  testClientReminderMattermost,
  previewClientReminder,
  getClientReminderHistory
};
