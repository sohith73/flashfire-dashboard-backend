// "Australia visa sponsors only" - the clients-tracking side of Utils/auVisaSponsor.js.
//
//   GET  /au-sponsor-only?email=           -> is this an Australian client, is the switch on, data status
//   POST /update-au-sponsor-only           { email, enabled, updatedBy? } -> flip the switch
//   GET  /au-visa-sponsors/lookup?company= -> would this employer pass?
//   POST /au-visa-sponsors/lookup { company, description? } -> same, plus would
//        this posting pass (description too long for a query string)
//
// Same access model as the UK and US endpoints next to them: the
// clients-tracking AI Summary page calls these from the browser. The switch can
// only be turned ON for an Australian client (422 otherwise), and not while the
// sponsor data is unloaded (503), because then every push would be refused.

import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { resolveClientCountry } from "../Utils/ukVisaSponsor.js";
import { lookupAuSponsor, auSponsorStatus, loadAuSponsors } from "../Utils/auVisaSponsor.js";
import { detectAuNoSponsorship } from "../Utils/auNoSponsorshipText.js";

const cleanEmail = (raw) => String(raw || "").toLowerCase().trim();

function dataStatus() {
  let status = auSponsorStatus();
  if (!status.loaded) {
    // Startup load failed or never ran in this process: one retry, so a file
    // that has since been deployed starts working without a restart.
    try {
      status = loadAuSponsors();
    } catch (e) {
      console.error("Australian sponsor data load failed:", e.message);
    }
  }
  return status;
}

export async function GetAuSponsorOnly(req, res) {
  try {
    const email = cleanEmail(req.query?.email);
    if (!email.includes("@")) {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "email is required" });
    }
    const [profile, client] = await Promise.all([
      ProfileModel.findOne({ email }).select("auSponsorOnly auSponsorOnlyMeta").lean(),
      resolveClientCountry(email),
    ]);
    if (!profile) {
      return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `no profile for ${email}` });
    }
    return res.json({
      success: true,
      email,
      isAuClient: client.isAu,
      clientCountry: client.country,
      countrySource: client.source,
      enabled: profile.auSponsorOnly === true,
      // On but not enforced: the client was re-tagged to another country.
      active: profile.auSponsorOnly === true && client.isAu,
      updatedAt: profile.auSponsorOnlyMeta?.updatedAt || null,
      updatedBy: profile.auSponsorOnlyMeta?.updatedBy || "",
      data: dataStatus(),
    });
  } catch (err) {
    console.error("GetAuSponsorOnly error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}

export async function UpdateAuSponsorOnly(req, res) {
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
      if (!client.isAu) {
        return res.status(422).json({
          success: false,
          error: "NOT_AU_CLIENT",
          message: `${email} is not an Australian client (country: ${client.country || "not set"}). Set the country to Australia in Client Job Analysis first.`,
        });
      }
      if (!dataStatus().loaded) {
        return res.status(503).json({
          success: false,
          error: "AU_SPONSOR_DATA_NOT_LOADED",
          message: "The Australian sponsor data is not loaded on the server, so every job would be refused. Deploy data/au-visa-sponsors.json.gz and restart.",
        });
      }
    }
    const profile = await ProfileModel.findOneAndUpdate(
      { email },
      {
        $set: {
          auSponsorOnly: enabled,
          "auSponsorOnlyMeta.updatedAt": new Date(),
          "auSponsorOnlyMeta.updatedBy": String(updatedBy || "clients-tracking").slice(0, 80),
        },
      },
      { new: true, lean: true, projection: { email: 1, auSponsorOnly: 1, auSponsorOnlyMeta: 1 } },
    );
    if (!profile) {
      return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `no profile for ${email}` });
    }
    return res.json({
      success: true,
      email: profile.email,
      enabled: profile.auSponsorOnly === true,
      updatedAt: profile.auSponsorOnlyMeta?.updatedAt || null,
      updatedBy: profile.auSponsorOnlyMeta?.updatedBy || "",
    });
  } catch (err) {
    console.error("UpdateAuSponsorOnly error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}

export async function LookupAuSponsor(req, res) {
  try {
    const company = String(req.body?.company ?? req.query?.company ?? "").trim().slice(0, 200);
    const description = String(req.body?.description ?? "").slice(0, 60000);
    if (!company) {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "company is required" });
    }
    if (!dataStatus().loaded) {
      return res.status(503).json({ success: false, error: "AU_SPONSOR_DATA_NOT_LOADED", message: "Australian sponsor data is not loaded on the server." });
    }
    // posting is null when no description was sent, so the shape never changes.
    const posting = description.trim() ? detectAuNoSponsorship(description) : null;
    return res.json({ success: true, company, ...lookupAuSponsor(company), posting });
  } catch (err) {
    console.error("LookupAuSponsor error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}
