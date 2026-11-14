// EuVisaSponsorModel: one document per employer and country on a European
// sponsor list: the IND register of recognised sponsors (NL) and the Irish
// employment permit company lists (IE). See DASH/eu-visa-sponsors/refresh.sh.
//
// Written only by scripts/import-eu-visa-sponsors.mjs. The push gate does NOT
// read this collection: Utils/euVisaSponsor.js matches the same data in memory
// (data/eu-visa-sponsors.json.gz), so a push costs no query. This copy is for
// querying and reporting from Mongo.

import mongoose from "mongoose";

export const EU_VISA_SPONSOR_COLLECTION = "euvisasponsors";

const EuVisaSponsorSchema = new mongoose.Schema(
  {
    // Lowercased, whitespace-collapsed name. Unique together with country.
    nameKey: { type: String, required: true },
    name: { type: String, required: true },
    // "NL" or "IE"
    country: { type: String, required: true },
    // The keys Utils/euVisaSponsor.js would match on.
    matchKeys: { type: [String], default: [] },
    // Dutch Chamber of Commerce number (NL rows only).
    kvk: { type: String, default: null },
    // Irish employment permits issued, by year: { "2025": 368, "2026": 270 }.
    permits: { type: Object, default: {} },
    permitsTotal: { type: Number, default: 0 },
    // builtAt of the data file this row came from; older rows are pruned.
    buildId: { type: String, required: true },
    importedAt: { type: Date, default: null },
  },
  { collection: EU_VISA_SPONSOR_COLLECTION, timestamps: false, versionKey: false, minimize: false },
);

EuVisaSponsorSchema.index({ country: 1, nameKey: 1 }, { unique: true });
EuVisaSponsorSchema.index({ matchKeys: 1 });
EuVisaSponsorSchema.index({ kvk: 1 }, { sparse: true });
EuVisaSponsorSchema.index({ buildId: 1 });

export const EuVisaSponsorModel =
  mongoose.models.EuVisaSponsor || mongoose.model("EuVisaSponsor", EuVisaSponsorSchema);
