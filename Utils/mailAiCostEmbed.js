// Mail AI cost card for the 5 AM daily mail summary on Discord.
//
// Reads the per-day token usage every mail AI call already records
// (Utils/aiUsage.js, sources mail-triage / mail-verify / mail-regex /
// mail-summary), prices it per model (Utils/aiRateCard.js, including a model
// priced through MAIL_AI_RATE_* env), and lays it out as one embed.
//
// The summary runs at 5 AM IST, so the card reports the previous IST day,
// which is complete by then.

import { getDailyUsage, istDay } from "./aiUsage.js";
import { isUnpricedModel } from "./aiRateCard.js";

const MAIL_SOURCE = /^mail-/;
const SOURCE_LABEL = {
  "mail-triage": "Second look (all non-marketing mail)",
  "mail-verify": "Verifier (milestones + rejections)",
  "mail-regex": "Regex learner",
  "mail-summary": "Summarizer",
};

const usd = (n) => `$${(Number(n) || 0).toFixed(n >= 1 ? 2 : 4)}`;
const rupees = (n) => `₹${(Number(n) || 0).toFixed(2)}`;
const fmtInt = (n) => (Number(n) || 0).toLocaleString("en-IN");

/** IST day before `now`, as YYYY-MM-DD. */
export function previousIstDay(now = new Date()) {
  return istDay(new Date(now.getTime() - 24 * 60 * 60 * 1000));
}

/** Pure: usage (from getDailyUsage) -> Discord embed. Exported for tests. */
export function buildMailAiCostEmbed(usage, { error = "" } = {}) {
  if (error) {
    return {
      title: "💸 Mail AI cost",
      color: 0xdc2626,
      description: `Could not read the AI usage: ${String(error).slice(0, 300)}`,
    };
  }
  const rows = (usage?.rows || []).filter((r) => MAIL_SOURCE.test(r.source));
  const day = usage?.day || "";
  if (!rows.length) {
    return { title: `💸 Mail AI cost, ${day} (IST)`, color: 0x64748b, description: "No mail AI calls that day." };
  }

  const totalUsd = rows.reduce((a, r) => a + r.usd, 0);
  const totalInr = rows.reduce((a, r) => a + r.inr, 0);
  const calls = rows.reduce((a, r) => a + r.calls, 0);
  const missing = rows.reduce((a, r) => a + r.callsMissingUsage, 0);

  // One line per model, then one per source, so a new provider's share is visible at a glance.
  const byModel = new Map();
  for (const r of rows) {
    const m = byModel.get(r.model) || { calls: 0, inTok: 0, outTok: 0, usd: 0, inr: 0 };
    m.calls += r.calls; m.inTok += r.inputTokens; m.outTok += r.outputTokens; m.usd += r.usd; m.inr += r.inr;
    byModel.set(r.model, m);
  }
  const modelLines = [...byModel.entries()]
    .sort((a, b) => b[1].usd - a[1].usd)
    .map(([model, m]) =>
      `**${model}**: ${fmtInt(m.calls)} calls, ${fmtInt(m.inTok)} in / ${fmtInt(m.outTok)} out tokens, ` +
      `${usd(m.usd)} (${rupees(m.inr)})${isUnpricedModel(model) ? " ⚠️ no price set, shown at the high fallback rate" : ""}`
    );

  const bySource = new Map();
  for (const r of rows) {
    const s = bySource.get(r.source) || { calls: 0, usd: 0, inr: 0 };
    s.calls += r.calls; s.usd += r.usd; s.inr += r.inr;
    bySource.set(r.source, s);
  }
  const sourceLines = [...bySource.entries()]
    .sort((a, b) => b[1].usd - a[1].usd)
    .map(([src, s]) => `${SOURCE_LABEL[src] || src}: ${fmtInt(s.calls)} calls, ${usd(s.usd)} (${rupees(s.inr)})`);

  const fields = [
    { name: "Total", value: `${usd(totalUsd)} (${rupees(totalInr)}) for ${fmtInt(calls)} calls`, inline: false },
    { name: "By model", value: modelLines.join("\n").slice(0, 1024), inline: false },
    { name: "By step", value: sourceLines.join("\n").slice(0, 1024), inline: false },
  ];
  if (missing) {
    fields.push({ name: "Note", value: `${fmtInt(missing)} call(s) returned no token count, so the total is a floor.`, inline: false });
  }
  return { title: `💸 Mail AI cost, ${day} (IST)`, color: 0xf59e0b, fields };
}

/** Reads yesterday's (IST) usage and builds the card. Never throws. */
export async function mailAiCostEmbed(now = new Date()) {
  try {
    return buildMailAiCostEmbed(await getDailyUsage(previousIstDay(now)));
  } catch (err) {
    return buildMailAiCostEmbed(null, { error: err?.message || String(err) });
  }
}
