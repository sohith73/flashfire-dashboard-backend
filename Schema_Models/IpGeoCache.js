import mongoose from "mongoose";

// One row per distinct IP we have ever geolocated.
//
// This is the piece that makes free geolocation actually work. Login IPs repeat
// heavily (the same client, the same office, the same VPN), so resolving each
// distinct address ONCE and keeping the answer means the providers get hit a
// handful of times a day instead of once per event. That is what removes the
// ~45 req/min ceiling that used to leave rows with an empty location — the
// in-process Map the old code used was lost on every restart and not shared
// between Render instances.
//
// It also gives operators something to correct: a row can be pinned by hand and
// the resolver will never overwrite it.

const VoteSchema = new mongoose.Schema(
  {
    provider: { type: String, default: "" },
    city: { type: String, default: "" },
    region: { type: String, default: "" },
    countryCode: { type: String, default: "" },
  },
  { _id: false }
);

const IpGeoCacheSchema = new mongoose.Schema(
  {
    ip: { type: String, required: true, unique: true, index: true },

    city: { type: String, default: "" },
    region: { type: String, default: "" },
    country: { type: String, default: "" },
    countryCode: { type: String, default: "" },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    timezone: { type: String, default: "" },

    // "consensus" — agreed by independent providers
    // "override"  — matched a pinned entry in ip_geo_overrides
    // "single"    — only one provider answered; treat with suspicion
    source: { type: String, default: "" },
    // high   — providers agreed on the city
    // medium — providers agreed on the region but not the city (city dropped)
    // low    — a lone provider answered
    confidence: { type: String, default: "", enum: ["", "high", "medium", "low"] },
    // Raw per-provider answers, kept so a human can see WHY we picked this and
    // judge a disagreement instead of trusting a single opaque string.
    votes: { type: [VoteSchema], default: [] },

    // Set by hand to freeze a row. refreshStale() and the resolver both skip
    // locked rows, so a manual correction survives every later lookup.
    locked: { type: Boolean, default: false },
    note: { type: String, default: "" },

    resolvedAt: { type: Date, default: Date.now },
    lookupCount: { type: Number, default: 1 },
  },
  { collection: "ip_geo_cache", versionKey: false }
);

IpGeoCacheSchema.index({ resolvedAt: -1 });

export const IpGeoCache =
  mongoose.models.IpGeoCache || mongoose.model("IpGeoCache", IpGeoCacheSchema);
