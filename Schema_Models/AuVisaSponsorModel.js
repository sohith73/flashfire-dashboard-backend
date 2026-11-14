// AuVisaSponsorModel: one document per employer on any Department of Home
// Affairs sponsor list (labour agreements, plus FOI releases of approved and
// accredited sponsors). See DASH/au-visa-sponsors/refresh.sh.
//
// Written only by scripts/import-au-visa-sponsors.mjs. The push gate does NOT
// read this collection: Utils/auVisaSponsor.js matches against the same data in
// memory (data/au-visa-sponsors.json.gz), so a push costs no query. This copy
// is for querying and reporting ("is X a sponsor?", counts by list) from Mongo.

import mongoose from "mongoose";

export const AU_VISA_SPONSOR_COLLECTION = "auvisasponsors";

const AuVisaSponsorSchema = new mongoose.Schema(
  {
    // Lowercased, whitespace-collapsed name. One document per value.
    nameKey: { type: String, required: true },
    name: { type: String, required: true },
    // The keys Utils/auVisaSponsor.js would match on (auNameKeys).
    matchKeys: { type: [String], default: [] },
    // LA (labour agreement), A25 / A24 (accredited), S23 (active sponsor), newest first.
    sources: { type: [String], default: [] },
    // Labour agreement types, e.g. "Company Specific", "Industry - Fishing".
    laTypes: { type: [String], default: [] },
    // Date of the newest list this employer is on, "YYYY-MM-DD".
    newestAsOf: { type: String, default: null },
    // builtAt of the data file this row came from; older rows are pruned.
    buildId: { type: String, required: true },
    importedAt: { type: Date, default: null },
  },
  { collection: AU_VISA_SPONSOR_COLLECTION, timestamps: false, versionKey: false },
);

AuVisaSponsorSchema.index({ nameKey: 1 }, { unique: true });
AuVisaSponsorSchema.index({ matchKeys: 1 });
AuVisaSponsorSchema.index({ sources: 1 });
AuVisaSponsorSchema.index({ buildId: 1 });

export const AuVisaSponsorModel =
  mongoose.models.AuVisaSponsor || mongoose.model("AuVisaSponsor", AuVisaSponsorSchema);
