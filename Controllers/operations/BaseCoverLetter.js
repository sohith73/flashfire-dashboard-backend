// Operations tab: a client's base cover letter.
//
//   GET /operations/base-cover-letter?clientEmail=&operatorEmail=
//       200 { ok, text, updatedAt, updatedBy, words, plan, executive,
//             stats: { optimized, pending, failed } }
//   PUT /operations/base-cover-letter  body { clientEmail, operatorEmail, operatorName, text }
//       200 { ok, updatedAt, words, queued }
//
// Both sit behind requireOpsKey (x-ops-key) and then re-check the operator
// against the database: operatorEmail must be a real Operations document that
// manages this client, or an admin (Utils/operatorAccess.js). Errors are
// { ok:false, error, message }: 400 client_required / text_required /
// base_letter_too_short / base_letter_too_long, 403 not_your_client,
// 404 client_not_found, 502 storage (GET), 500 server_error / storage_failed.
//
// Saving puts every saved job card with an optimized resume whose letter came
// from another base into the cover letter queue (Executive clients only).
// Empty text deletes the base letter; letters already written stay.

import Operations from "../../Schema_Models/Operations.js";
import { UserModel } from "../../Schema_Models/UserModel.js";
import { JobModel } from "../../Schema_Models/JobModel.js";
import { operatorManagesClient } from "../../Utils/operatorAccess.js";
import { isExecutivePlan } from "../../Utils/speedyApplyCoverLetterWriter.js";
import {
  deleteBaseLetter,
  loadBaseLetterText,
  saveBaseLetter,
  validateBaseLetterInput,
} from "../../Utils/baseCoverLetter.js";
import { statsFilters } from "../../Utils/coverLetterQueue.js";
import { findClientByEmail, requeueClientCards } from "../../Utils/coverLetterAutoWriter.js";

const fail = (res, status, error, message) => res.status(status).json({ ok: false, error, message });
const lowerTrim = (v) => String(v || "").toLowerCase().trim();

/**
 * Who is asking, for whom. Resolves to { client, operator } or sends the
 * error response and resolves to null.
 */
async function authorize(res, { clientEmail, operatorEmail }) {
  if (!clientEmail.includes("@")) {
    fail(res, 400, "client_required", "clientEmail is required.");
    return null;
  }
  const deny = () => {
    fail(res, 403, "not_your_client", "You do not manage this client.");
    return null;
  };
  if (!operatorEmail.includes("@")) return deny();
  const operator = await Operations.findOne({ email: operatorEmail }).select("email name role managedUsers").lean();
  if (!operator) return deny();
  const client = await findClientByEmail(clientEmail, "_id name email planType baseCoverLetter");
  if (!client) {
    fail(res, 404, "client_not_found", "No client with that email.");
    return null;
  }
  if (!operatorManagesClient(operator, client._id)) return deny();
  return { client, operator };
}

const clientEmailsOf = (client, clientEmail) => [...new Set([client.email, clientEmail].filter(Boolean))];

// GET /operations/base-cover-letter
export async function getBaseCoverLetter(req, res) {
  try {
    const who = await authorize(res, {
      clientEmail: lowerTrim(req.query?.clientEmail),
      operatorEmail: lowerTrim(req.query?.operatorEmail),
    });
    if (!who) return undefined;
    const { client } = who;
    const pointer = client.baseCoverLetter || null;

    let text = "";
    if (pointer?.key) {
      const loaded = await loadBaseLetterText(pointer);
      if (!loaded.ok && loaded.reason === "storage") {
        return fail(res, 502, "storage", "Could not read the cover letter from storage. Try again.");
      }
      text = loaded.ok ? loaded.text : "";
    }

    const f = statsFilters(clientEmailsOf(client, lowerTrim(req.query?.clientEmail)));
    const [optimized, pending, failed] = await Promise.all([
      JobModel.countDocuments(f.optimized),
      JobModel.countDocuments(f.pending),
      JobModel.countDocuments(f.failed),
    ]);

    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      text,
      updatedAt: pointer?.key && pointer.updatedAt ? new Date(pointer.updatedAt).toISOString() : null,
      updatedBy: pointer?.key ? String(pointer.updatedBy || "") : "",
      words: pointer?.key ? Number(pointer.words) || 0 : 0,
      plan: client.planType || null,
      executive: isExecutivePlan(client.planType),
      stats: { optimized, pending, failed },
    });
  } catch (err) {
    console.error("[base-cover-letter] GET failed:", err?.message || err);
    return fail(res, 500, "server_error", "Could not load the cover letter.");
  }
}

// PUT /operations/base-cover-letter
export async function putBaseCoverLetter(req, res) {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const clientEmail = lowerTrim(body.clientEmail);
    const who = await authorize(res, { clientEmail, operatorEmail: lowerTrim(body.operatorEmail) });
    if (!who) return undefined;
    const { client, operator } = who;

    const input = validateBaseLetterInput(body.text, { name: client.name });
    if (!input.ok) return fail(res, 400, input.error, input.message);

    const now = new Date();
    if (input.empty) {
      const key = client.baseCoverLetter?.key;
      if (key) {
        const del = await deleteBaseLetter(key);
        if (!del.ok) console.error(`[base-cover-letter] R2 delete failed for ${key} (pointer removed anyway): ${del.error}`);
      }
      await UserModel.updateOne({ _id: client._id }, { $unset: { baseCoverLetter: 1 } });
      return res.status(200).json({ ok: true, updatedAt: now.toISOString(), words: 0, queued: 0 });
    }

    const updatedBy = String(operator.name || body.operatorName || operator.email || "").trim().slice(0, 120);
    const saved = await saveBaseLetter({ clientEmail: client.email || clientEmail, text: input.text, updatedAt: now, updatedBy });
    if (!saved.ok) {
      console.error(`[base-cover-letter] R2 save failed for ${clientEmail}: ${saved.error}`);
      return fail(res, 500, "storage_failed", "Could not save the cover letter. Try again.");
    }
    await UserModel.updateOne(
      { _id: client._id },
      { $set: { baseCoverLetter: { key: saved.key, updatedAt: now, updatedBy, words: input.words, hash: input.hash } } },
    );

    const queued = isExecutivePlan(client.planType) ? await requeueClientCards(clientEmailsOf(client, clientEmail), input.hash) : 0;
    console.log(`[base-cover-letter] ${clientEmail} saved by ${operator.email}: ${input.words} words, ${queued} card(s) queued`);
    return res.status(200).json({ ok: true, updatedAt: now.toISOString(), words: input.words, queued });
  } catch (err) {
    console.error("[base-cover-letter] PUT failed:", err?.message || err);
    return fail(res, 500, "server_error", "Could not save the cover letter.");
  }
}
