// Per-client configuration for the operator-managed "Client Reminders" feature.
//
// One document per client email. Operations picks which recurring reports go
// out, over which channels, and at what IST time; src/services/clientReminderWorker.js
// reads these docs every five minutes and delivers whatever is due.
//
// The item list is NOT free-form. Every row is keyed by a catalogue entry from
// Utils/reminderItems.js, and mergeWithDefaults() guarantees the caller sees
// every catalogue item in catalogue order whether or not Mongo has a row for
// it. That is what lets the UI render the tab from a single API payload and
// lets the worker iterate without null checks.

import mongoose from "mongoose";
import {
  REMINDER_ITEM_KEYS,
  reminderItemMeta,
  defaultItemConfig,
  defaultItems,
  isValidSendAt
} from "../Utils/reminderItems.js";

const getCurrentISTTime = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

/**
 * History is an audit trail, not a data warehouse. Fifty rows is roughly six
 * weeks of daily sends, which is all an operator ever scrolls back through,
 * and it keeps the document comfortably inside Mongo's 16MB ceiling no matter
 * how long a client stays on the plan.
 */
export const HISTORY_LIMIT = 50;

/** Clamps applied by sanitizeItemsInput. dayOfMonth stops at 28 so a monthly */
/** report can never silently skip February. */
const DAY_OF_WEEK_MIN = 0;
const DAY_OF_WEEK_MAX = 6;
const DAY_OF_MONTH_MIN = 1;
const DAY_OF_MONTH_MAX = 28;
const INACTIVITY_DAYS_MIN = 1;
const INACTIVITY_DAYS_MAX = 30;
// A threshold of 1 would mail on the first role of the day, which is noise.
// 200 is far above any real daily push and stops a typo disabling the feature
// silently by setting an unreachable bar.
const AUTO_THRESHOLD_MIN = 2;
const AUTO_THRESHOLD_MAX = 200;
// Zero is allowed (send immediately). The ceiling keeps the delay inside the
// same IST day, or the period key rolls over and the mail is never sent.
const AUTO_DELAY_MIN = 0;
const AUTO_DELAY_MAX = 720;

const reminderItemSchema = new mongoose.Schema(
  {
    key: { type: String, enum: REMINDER_ITEM_KEYS, required: true },
    enabled: { type: Boolean, default: false },
    channels: {
      mattermost: { type: Boolean, default: false },
      email: { type: Boolean, default: false }
    },
    sendAtIST: { type: String, default: "09:00" },
    dayOfWeek: { type: Number, default: 1 },
    dayOfMonth: { type: Number, default: 1 },
    inactivityDays: { type: Number, default: 3 },

    // Threshold auto-send for the daily summary: once autoThresholdCount roles
    // have been added today, deliver autoDelayMinutes later instead of waiting
    // for sendAtIST. Consumes the same daily period key, so the client still
    // gets exactly one summary per day.
    autoOnThreshold: { type: Boolean, default: false },
    autoThresholdCount: { type: Number, default: 5 },
    autoDelayMinutes: { type: Number, default: 60 },

    // Delivery bookkeeping, written only by the worker / send-now path.
    // lastPeriodKey is the idempotency token: the worker refuses to send an
    // item whose computed period key already matches this value.
    lastPeriodKey: { type: String, default: "" },
    lastSentAt: { type: Date, default: null },
    lastStatus: { type: String, default: "" },
    lastError: { type: String, default: "" }
  },
  { _id: false }
);

const reminderHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: null },
    itemKey: { type: String, default: "" },
    periodKey: { type: String, default: "" },
    status: { type: String, default: "" },
    email: {
      attempted: { type: Boolean, default: false },
      ok: { type: Boolean, default: false },
      to: { type: String, default: "" },
      error: { type: String, default: "" }
    },
    mattermost: {
      attempted: { type: Boolean, default: false },
      ok: { type: Boolean, default: false },
      error: { type: String, default: "" }
    },
    stats: {
      added: { type: Number, default: 0 },
      applied: { type: Number, default: 0 }
    },
    trigger: { type: String, default: "" }
  },
  { _id: false }
);

const clientReminderConfigSchema = new mongoose.Schema(
  {
    clientEmail: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    clientName: { type: String, default: "" },

    /**
     * Forward inbox milestones (interview / assignment / offer) detected by the
     * hourly mail poll to this client, over whichever of the two channels below
     * are configured.
     *
     * Default FALSE, and it must stay that way. Unlike the scheduled reports
     * this is driven by a CLASSIFIER reading the client's real mailbox, so a
     * false positive does not send a wrong number - it sends "you've got an
     * offer" to somebody who has not. That has happened before (an Amazon
     * "thank you for applying" auto-reply), which is why the whole stream was
     * paused. Opt in per client, deliberately.
     */
    inboxAlertsEnabled: { type: Boolean, default: false },

    // Only consulted when dashboardtrackings has no paymentEmail for this
    // client. The tracking collection is owned by the applications-monitor
    // backend, so it stays the source of truth wherever it has an answer.
    paymentEmailOverride: { type: String, default: "", lowercase: true, trim: true },

    mattermostWebhookUrl: { type: String, default: "" },

    items: { type: [reminderItemSchema], default: [] },
    history: { type: [reminderHistorySchema], default: [] },

    updatedBy: { type: String, default: "" },

    // IST locale strings, matching the convention every other operations
    // document in this codebase uses. Deliberately not Mongoose timestamps.
    createdAt: { type: String, default: getCurrentISTTime },
    updatedAt: { type: String, default: getCurrentISTTime }
  },
  { timestamps: false }
);

export const ClientReminderConfig =
  mongoose.models.ClientReminderConfig ||
  mongoose.model("ClientReminderConfig", clientReminderConfigSchema);

function toPlain(doc) {
  if (!doc) return {};
  if (typeof doc.toObject === "function") return doc.toObject({ depopulate: true });
  return doc;
}

/**
 * Coerce an operator-supplied value to a real boolean.
 *
 * The tab posts JSON, and "did the operator tick this box" arrives as a real
 * boolean, as the string "true"/"false" (a form-encoded proxy, or a select),
 * or as 1/0 (a checkbox serialised by value). All three mean the same thing to
 * the person who clicked, so all three are honoured. Anything else - undefined,
 * null, "maybe", 7 - is not an answer, and falls back to the catalogue default
 * rather than being silently read as false: a nonsense payload must not be
 * able to switch a client's reports off.
 */
function boolOr(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
  }
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normaliseItemRow(raw, key) {
  const base = defaultItemConfig(key);
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    key,
    enabled: boolOr(src.enabled, base.enabled),
    channels: {
      mattermost: boolOr(src.channels?.mattermost, base.channels.mattermost),
      email: boolOr(src.channels?.email, base.channels.email)
    },
    sendAtIST: isValidSendAt(src.sendAtIST) ? String(src.sendAtIST) : base.sendAtIST,
    dayOfWeek: clampInt(src.dayOfWeek, DAY_OF_WEEK_MIN, DAY_OF_WEEK_MAX, base.dayOfWeek),
    dayOfMonth: clampInt(src.dayOfMonth, DAY_OF_MONTH_MIN, DAY_OF_MONTH_MAX, base.dayOfMonth),
    inactivityDays: clampInt(src.inactivityDays, INACTIVITY_DAYS_MIN, INACTIVITY_DAYS_MAX, base.inactivityDays),
    autoOnThreshold: boolOr(src.autoOnThreshold, base.autoOnThreshold),
    autoThresholdCount: clampInt(src.autoThresholdCount, AUTO_THRESHOLD_MIN, AUTO_THRESHOLD_MAX, base.autoThresholdCount),
    autoDelayMinutes: clampInt(src.autoDelayMinutes, AUTO_DELAY_MIN, AUTO_DELAY_MAX, base.autoDelayMinutes),
    lastPeriodKey: String(src.lastPeriodKey || ""),
    lastSentAt: src.lastSentAt ? new Date(src.lastSentAt) : null,
    lastStatus: String(src.lastStatus || ""),
    lastError: String(src.lastError || "")
  };
}

function normaliseHistoryRow(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const at = src.at ? new Date(src.at) : null;
  return {
    at: at && !Number.isNaN(at.getTime()) ? at : null,
    itemKey: String(src.itemKey || ""),
    periodKey: String(src.periodKey || ""),
    status: String(src.status || ""),
    email: {
      attempted: src.email?.attempted === true,
      ok: src.email?.ok === true,
      to: String(src.email?.to || ""),
      error: String(src.email?.error || "")
    },
    mattermost: {
      attempted: src.mattermost?.attempted === true,
      ok: src.mattermost?.ok === true,
      error: String(src.mattermost?.error || "")
    },
    stats: {
      added: Number.isFinite(Number(src.stats?.added)) ? Number(src.stats.added) : 0,
      applied: Number.isFinite(Number(src.stats?.applied)) ? Number(src.stats.applied) : 0
    },
    trigger: String(src.trigger || "")
  };
}

/**
 * A fully-populated, plain-object view of a config document.
 *
 * Accepts a Mongoose document, a lean object, or null/undefined - passing
 * nothing back a brand-new client returns the catalogue defaults without
 * touching Mongo, which is exactly what the GET route needs (reading the tab
 * for a client must not create a document).
 *
 * Guarantees, relied on by the worker and the UI:
 *   • every catalogue item is present, exactly once, in catalogue order
 *   • item keys that are no longer in the catalogue are dropped, so retiring
 *     an item cannot leave the worker iterating over a row it cannot render
 *   • every field has a real value, never undefined
 *
 * @param {object|null} doc
 * @returns {object}
 */
export function mergeWithDefaults(doc) {
  const src = toPlain(doc);
  const stored = new Map();
  for (const row of Array.isArray(src.items) ? src.items : []) {
    const key = String(row?.key || "");
    // First row wins. A duplicate key can only come from a hand-edited
    // document, and picking deterministically beats picking arbitrarily.
    if (reminderItemMeta(key) && !stored.has(key)) stored.set(key, row);
  }

  const items = REMINDER_ITEM_KEYS.map((key) =>
    stored.has(key) ? normaliseItemRow(stored.get(key), key) : defaultItemConfig(key)
  );

  const history = (Array.isArray(src.history) ? src.history : [])
    .slice(0, HISTORY_LIMIT)
    .map(normaliseHistoryRow);

  return {
    clientEmail: String(src.clientEmail || "").toLowerCase().trim(),
    clientName: String(src.clientName || ""),
    // Absent on every row written before this shipped. Reading a missing field
    // as false is the safe direction: an un-migrated client stays silent until
    // somebody opts them in.
    inboxAlertsEnabled: src.inboxAlertsEnabled === true,
    paymentEmailOverride: String(src.paymentEmailOverride || "").toLowerCase().trim(),
    mattermostWebhookUrl: String(src.mattermostWebhookUrl || "").trim(),
    items,
    history,
    updatedBy: String(src.updatedBy || ""),
    createdAt: String(src.createdAt || ""),
    updatedAt: String(src.updatedAt || "")
  };
}

/**
 * The trust boundary for operator-supplied item settings.
 *
 * Everything that arrives over HTTP is treated as hostile: values are clamped
 * into range, coerced to the right type, unknown item keys are dropped, and a
 * malformed sendAtIST falls back to the catalogue default rather than being
 * written through (a bad time string would make isItemDue() evaluate to false
 * forever and the item would silently never fire).
 *
 * TRAP THIS GUARDS - delivery state must survive a settings save.
 * lastPeriodKey / lastSentAt / lastStatus / lastError are idempotency and
 * audit fields owned exclusively by the worker. If an operator opening the tab
 * and hitting Save round-tripped whatever the browser happened to hold (or,
 * worse, nothing at all), lastPeriodKey would reset to "" and the item would
 * re-arm for a period it has already delivered - the client gets the same
 * daily summary twice. So those four fields are read ONLY from `existingItems`
 * and the incoming payload's copies are discarded outright.
 *
 * @param {Array} items          operator-supplied rows
 * @param {Array} [existingItems] rows currently persisted, for state carry-over
 * @returns {Array} one row per catalogue item, in catalogue order
 */
export function sanitizeItemsInput(items, existingItems = []) {
  const incoming = new Map();
  for (const row of Array.isArray(items) ? items : []) {
    const key = String(row?.key || "");
    if (reminderItemMeta(key) && !incoming.has(key)) incoming.set(key, row);
  }

  const existing = new Map();
  for (const row of Array.isArray(existingItems) ? existingItems : []) {
    const key = String(row?.key || "");
    if (reminderItemMeta(key) && !existing.has(key)) existing.set(key, row);
  }

  return REMINDER_ITEM_KEYS.map((key) => {
    const base = defaultItemConfig(key);
    const prev = existing.get(key) || null;
    const next = incoming.get(key) || null;

    // Absent vs invalid are different things. An omitted field keeps whatever
    // is already stored; a field that is present but unusable falls back to
    // the catalogue default so the item stays in a sendable state.
    const pick = (field, fallback) => {
      if (next && next[field] !== undefined && next[field] !== null) return next[field];
      if (prev && prev[field] !== undefined && prev[field] !== null) return prev[field];
      return fallback;
    };

    const enabled = boolOr(pick("enabled", base.enabled), base.enabled);

    const rawMattermost =
      next?.channels?.mattermost !== undefined
        ? next.channels.mattermost
        : prev?.channels?.mattermost;
    const rawEmail =
      next?.channels?.email !== undefined ? next.channels.email : prev?.channels?.email;

    const rawSendAt = pick("sendAtIST", base.sendAtIST);

    return {
      key,
      enabled,
      channels: {
        mattermost: boolOr(rawMattermost, base.channels.mattermost),
        email: boolOr(rawEmail, base.channels.email)
      },
      sendAtIST: isValidSendAt(rawSendAt) ? String(rawSendAt) : base.sendAtIST,
      dayOfWeek: clampInt(pick("dayOfWeek", base.dayOfWeek), DAY_OF_WEEK_MIN, DAY_OF_WEEK_MAX, base.dayOfWeek),
      dayOfMonth: clampInt(
        pick("dayOfMonth", base.dayOfMonth),
        DAY_OF_MONTH_MIN,
        DAY_OF_MONTH_MAX,
        base.dayOfMonth
      ),
      inactivityDays: clampInt(
        pick("inactivityDays", base.inactivityDays),
        INACTIVITY_DAYS_MIN,
        INACTIVITY_DAYS_MAX,
        base.inactivityDays
      ),

      autoOnThreshold: boolOr(pick("autoOnThreshold", base.autoOnThreshold), base.autoOnThreshold),
      autoThresholdCount: clampInt(
        pick("autoThresholdCount", base.autoThresholdCount),
        AUTO_THRESHOLD_MIN,
        AUTO_THRESHOLD_MAX,
        base.autoThresholdCount
      ),
      autoDelayMinutes: clampInt(
        pick("autoDelayMinutes", base.autoDelayMinutes),
        AUTO_DELAY_MIN,
        AUTO_DELAY_MAX,
        base.autoDelayMinutes
      ),

      // Worker-owned. Never sourced from `items`. See the trap note above.
      lastPeriodKey: String(prev?.lastPeriodKey || ""),
      lastSentAt: prev?.lastSentAt ? new Date(prev.lastSentAt) : null,
      lastStatus: String(prev?.lastStatus || ""),
      lastError: String(prev?.lastError || "")
    };
  });
}

/** Newest-first, hard-capped history for a write. Used by the worker and send-now. */
export function capHistory(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, HISTORY_LIMIT).map(normaliseHistoryRow);
}

export { getCurrentISTTime, defaultItems };

export default ClientReminderConfig;
