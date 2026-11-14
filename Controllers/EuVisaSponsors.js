// "Europe visa sponsors only" - the clients-tracking side of Utils/euVisaSponsor.js.
//
//   GET  /eu-sponsor-only?email=           -> is this a Europe client, is the switch on, data status
//   POST /update-eu-sponsor-only           { email, enabled, updatedBy? } -> flip the switch
//   GET  /eu-visa-sponsors/lookup?company=&location= -> would this employer pass for a job there?
//   POST /eu-visa-sponsors/lookup { company, location?, description? } -> same, plus would
//        this posting pass (description too long for a query string)
//
// Same access model as the UK and US endpoints next to them: the
// clients-tracking AI Summary page calls these from the browser. The switch can
// only be turned ON for a Europe client (422 otherwise), and not while the
// sponsor data is unloaded (503), because then every push would be refused.

import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { resolveClientCountry } from "../Utils/ukVisaSponsor.js";
import { lookupEuSponsor, euSponsorStatus, loadEuSponsors } from "../Utils/euVisaSponsor.js";
import { detectEuNoSponsorship } from "../Utils/euNoSponsorshipText.js";

const cleanEmail = (raw) => String(raw || "").toLowerCase().trim();

function dataStatus() {
  let status = euSponsorStatus();
  if (!status.loaded) {
    // Startup load failed or never ran in this process: one retry, so a file
    // that has since been deployed starts working without a restart.
    try {
      status = loadEuSponsors();
    } catch (e) {
      console.error("European sponsor data load failed:", e.message);
    }
  }
  return status;
}

export async function GetEuSponsorOnly(req, res) {
  try {
    const email = cleanEmail(req.query?.email);
    if (!email.includes("@")) {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "email is required" });
    }
    const [profile, client] = await Promise.all([
      ProfileModel.findOne({ email }).select("euSponsorOnly euSponsorOnlyMeta").lean(),
      resolveClientCountry(email),
    ]);
    if (!profile) {
      return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `no profile for ${email}` });
    }
    return res.json({
      success: true,
      email,
      isEuClient: client.isEu,
      clientCountry: client.country,
      countrySource: client.source,
      enabled: profile.euSponsorOnly === true,
      // On but not enforced: the client was re-tagged to another country.
      active: profile.euSponsorOnly === true && client.isEu,
      updatedAt: profile.euSponsorOnlyMeta?.updatedAt || null,
      updatedBy: profile.euSponsorOnlyMeta?.updatedBy || "",
      data: dataStatus(),
    });
  } catch (err) {
    console.error("GetEuSponsorOnly error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}

export async function UpdateEuSponsorOnly(req, res) {
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
      if (!client.isEu) {
        return res.status(422).json({
          success: false,
          error: "NOT_EU_CLIENT",
          message: `${email} is not a Europe client (country: ${client.country || "not set"}). Set the country to Europe in Client Job Analysis first.`,
        });
      }
      if (!dataStatus().loaded) {
        return res.status(503).json({
          success: false,
          error: "EU_SPONSOR_DATA_NOT_LOADED",
          message: "The European sponsor data is not loaded on the server, so every job would be refused. Deploy data/eu-visa-sponsors.json.gz and restart.",
        });
      }
    }
    const profile = await ProfileModel.findOneAndUpdate(
      { email },
      {
        $set: {
          euSponsorOnly: enabled,
          "euSponsorOnlyMeta.updatedAt": new Date(),
          "euSponsorOnlyMeta.updatedBy": String(updatedBy || "clients-tracking").slice(0, 80),
        },
      },
      { new: true, lean: true, projection: { email: 1, euSponsorOnly: 1, euSponsorOnlyMeta: 1 } },
    );
    if (!profile) {
      return res.status(404).json({ success: false, error: "PROFILE_NOT_FOUND", message: `no profile for ${email}` });
    }
    return res.json({
      success: true,
      email: profile.email,
      enabled: profile.euSponsorOnly === true,
      updatedAt: profile.euSponsorOnlyMeta?.updatedAt || null,
      updatedBy: profile.euSponsorOnlyMeta?.updatedBy || "",
    });
  } catch (err) {
    console.error("UpdateEuSponsorOnly error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}

export async function LookupEuSponsor(req, res) {
  try {
    const company = String(req.body?.company ?? req.query?.company ?? "").trim().slice(0, 200);
    const location = String(req.body?.location ?? req.query?.location ?? "").trim().slice(0, 200);
    const description = String(req.body?.description ?? "").slice(0, 60000);
    if (!company) {
      return res.status(400).json({ success: false, error: "BAD_INPUT", message: "company is required" });
    }
    if (!dataStatus().loaded) {
      return res.status(503).json({ success: false, error: "EU_SPONSOR_DATA_NOT_LOADED", message: "European sponsor data is not loaded on the server." });
    }
    // posting is null when no description was sent, so the shape never changes.
    const posting = description.trim() ? detectEuNoSponsorship(description) : null;
    return res.json({ success: true, company, location, ...lookupEuSponsor(company, location), posting });
  } catch (err) {
    console.error("LookupEuSponsor error:", err);
    return res.status(500).json({ success: false, error: "INTERNAL", message: err.message });
  }
}
