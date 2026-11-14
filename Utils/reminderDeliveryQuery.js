// Input parsing for POST /operations/reminders/deliveries, the paginated
// reminder history. Pure, so the filter and paging rules are unit-tested
// without a database.

export const DELIVERY_STATUSES = ["sent", "failed", "skipped"];
// "delivered" is the old name for "sent", still accepted from older clients.
export const STATUS_FILTERS = ["all", "delivered", ...DELIVERY_STATUSES];

// Email is the only channel. Rows written while Mattermost was a second channel
// can say "partial"; what counts now is whether their email went out.
const LEGACY_SENT = { status: "partial", "email.ok": true };
const LEGACY_FAILED = { status: "partial", "email.ok": { $ne: true } };

/** Mongo filter clause for one status, legacy "partial" rows folded in. */
export function statusClause(status) {
  if (status === "sent" || status === "delivered") return { $or: [{ status: "sent" }, LEGACY_SENT] };
  if (status === "failed") return { $or: [{ status: "failed" }, LEGACY_FAILED] };
  if (status === "skipped") return { status: "skipped" };
  return {};
}

/** $group key giving each row its email-only status, for the per-status counts. */
export const EFFECTIVE_STATUS = {
  $cond: [
    { $eq: ["$status", "partial"] },
    { $cond: [{ $eq: ["$email.ok", true] }, "sent", "failed"] },
    "$status"
  ]
};
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-11-12" -> the UTC instant of 00:00 IST that day, or null. */
function istDayStart(day) {
  if (!DAY_RE.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  // Date.parse rolls "2026-02-31" over to March; refuse it instead.
  if (new Date(t).toISOString().slice(0, 10) !== day) return null;
  return new Date(t - IST_OFFSET_MS);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * @param {object} body request body
 * @param {(key: string) => boolean} isItemKey validates itemKey against the catalogue
 * @returns {{ ok: true, filter: object, countsFilter: object, page: number, pageSize: number }
 *         | { ok: false, message: string }}
 *   filter       the Mongo filter for the rows and the total
 *   countsFilter the same filter without the status clause, for the per-status counts
 */
export function parseDeliveryQuery(body = {}, isItemKey = () => true) {
  const base = {};

  // One client's history only: Operations > Reminders is opened per client.
  const clientEmail = String(body.clientEmail || "").trim().toLowerCase();
  if (!clientEmail) return { ok: false, message: "clientEmail is required" };
  if (!EMAIL_RE.test(clientEmail)) return { ok: false, message: "clientEmail is not a valid email address" };
  base.clientEmail = clientEmail;

  const itemKey = String(body.itemKey || "").trim();
  if (itemKey) {
    if (!isItemKey(itemKey)) return { ok: false, message: `Unknown itemKey '${itemKey}'` };
    base.itemKey = itemKey;
  }

  const fromRaw = String(body.from || "").trim();
  const toRaw = String(body.to || "").trim();
  const from = fromRaw ? istDayStart(fromRaw) : null;
  const toStart = toRaw ? istDayStart(toRaw) : null;
  if (fromRaw && !from) return { ok: false, message: "from must be a date like 2026-11-12" };
  if (toRaw && !toStart) return { ok: false, message: "to must be a date like 2026-11-12" };
  if (from && toStart && from > toStart) return { ok: false, message: "from is after to" };
  if (from || toStart) {
    base.at = {};
    if (from) base.at.$gte = from;
    // Inclusive of the whole "to" day in IST.
    if (toStart) base.at.$lt = new Date(toStart.getTime() + DAY_MS);
  }

  const status = String(body.status || "all").trim().toLowerCase();
  if (!STATUS_FILTERS.includes(status)) {
    return { ok: false, message: `status must be one of: ${STATUS_FILTERS.join(", ")}` };
  }
  const filter = { ...base, ...statusClause(status) };

  const page = positiveInt(body.page, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, positiveInt(body.pageSize, DEFAULT_PAGE_SIZE));

  return { ok: true, filter, countsFilter: base, page, pageSize };
}
