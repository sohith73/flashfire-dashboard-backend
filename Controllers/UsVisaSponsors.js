// "US H-1B sponsors only" - the clients-tracking side of Utils/usVisaSponsor.js.
//
//   GET  /us-sponsor-only?email=           -> is this a US client, is the switch on, data status
//   POST /update-us-sponsor-only           { email, enabled, updatedBy? } -> flip the switch
//   GET  /us-visa-sponsors/lookup?company= -> would this employer pass?
//   POST /us-visa-sponsors/lookup { company, description? } -> same, plus would
//        this posting pass (description too long for a query string)
//
// Same access model as the UK endpoints next to them (/uk-sponsor-only): the
// clients-tracking AI Summary page calls these from the browser. The switch can
// only be turned ON for a US client (422 otherwise), and not while the sponsor
// data is unloaded (503), because then every push would be refused.

import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { resolveClientCountry } from "../Utils/ukVisaSponsor.js";
import { lookupUsSponsor, usSponsorStatus, loadUsSponsors } from "../Utils/usVisaSponsor.js";
import { detectNoSponsorship } from "../Utils/noSponsorshipText.js";

const cleanEmail = (raw) => String(raw || "").toLowerCase().trim();

function dataStatus() {
  let status = usSponsorStatus();
  if (!status.loaded) {
    // Startup load failed or never ran in this process: one retry, so a file
    // that has since been deployed starts working without a restart.
    try {
      status = loadUsSponsors();
    } catch (e) {
      console.error("US sponsor data load failed:", e.message);
    }
  }
  return status;
}

export async function GetUsSponsorOnly(req, res) {
  try {
    const email = cleanEmail(req.query?.email);
    if (!email.includes("@")) {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "email is required" });
    }
    const [profile, client] = await Promise.all([
      ProfileModel.findOne({ email }).select("usSponsorOnly usSponsorOnlyMeta").lean(),
      resolveClientCountry(email),
    ]);
    if (!profile) {
      return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `no profile for ${email}` });
    }
    return res.json({
      success: true,
      email,
      isUsClient: client.isUs,
      clientCountry: client.country,
      countrySource: client.source,
      enabled: profile.usSponsorOnly === true,
      // On but not enforced: the client was re-tagged to another country.
      active: profile.usSponsorOnly === true && client.isUs,
      updatedAt: profile.usSponsorOnlyMeta?.updatedAt || null,
      updatedBy: profile.usSponsorOnlyMeta?.updatedBy || "",
      data: dataStatus(),
    });
  } catch (err) {
    console.error("GetUsSponsorOnly error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}

export async function UpdateUsSponsorOnly(req, res) {
  try {
    const { email: rawEmail, enabled, updatedBy } = req.body || {};
    const email = cleanEmail(rawEmail);
    if (!email.includes("@")) {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "email is required" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "enabled must be true or false" });
    }
    if (enabled) {
      const client = await resolveClientCountry(email);
      if (!client.isUs) {
        return res.status(422).json({
          success: false,
          error: "NOT_US_CLIENT",
          message: `${email} is not a US client (country: ${client.country || "not set"}). Set the country to USA in Client Job Analysis first.`,
        });
      }
      if (!dataStatus().loaded) {
        return res.status(503).json({
          success: false,
          error: "US_SPONSOR_DATA_NOT_LOADED",
          message: "The US H-1B sponsor data is not loaded on the server, so every job would be refused. Deploy data/us-h1b-sponsors.json.gz and restart.",
        });
      }
    }
    const profile = await ProfileModel.findOneAndUpdate(
      { email },
      {
        $set: {
          usSponsorOnly: enabled,
          "usSponsorOnlyMeta.updatedAt": new Date(),
          "usSponsorOnlyMeta.updatedBy": String(updatedBy || "clients-tracking").slice(0, 80),
        },
      },
      { new: true, lean: true, projection: { email: 1, usSponsorOnly: 1, usSponsorOnlyMeta: 1 } },
    );
    if (!profile) {
      return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `no profile for ${email}` });
    }
    return res.json({
      success: true,
      email: profile.email,
      enabled: profile.usSponsorOnly === true,
      updatedAt: profile.usSponsorOnlyMeta?.updatedAt || null,
      updatedBy: profile.usSponsorOnlyMeta?.updatedBy || "",
    });
  } catch (err) {
    console.error("UpdateUsSponsorOnly error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}

export async function LookupUsSponsor(req, res) {
  try {
    const company = String(req.body?.company ?? req.query?.company ?? "").trim().slice(0, 200);
    const description = String(req.body?.description ?? "").slice(0, 60000);
    if (!company) {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "company is required" });
    }
    if (!dataStatus().loaded) {
      return res.status(503).json({ success: false, error: "US_SPONSOR_DATA_NOT_LOADED", message: "US H-1B sponsor data is not loaded on the server." });
    }
    // posting is null when no description was sent, so the shape never changes.
    const posting = description.trim() ? detectNoSponsorship(description) : null;
    return res.json({ success: true, company, since: usSponsorStatus().since, ...lookupUsSponsor(company), posting });
  } catch (err) {
    console.error("LookupUsSponsor error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}
