import mongoose from "mongoose";

// Hand-pinned IP/CIDR → location entries. Checked before any provider, so an
// entry here is final: never overwritten by a lookup, never expires.
//
// This lives in Mongo rather than a committed JSON file because the file would
// be unreachable in production — Render gives no shell, and anything written to
// the container filesystem is wiped on the next deploy. A correction is only
// useful if an operator can make it from the running system, so overrides are
// managed over /admin/geo/overrides and shared by every instance.
//
// This is the cure for the case free geolocation cannot solve: an office line,
// a VPN exit, a corporate NAT, or an ISP whose registered address sits nowhere
// near its subscribers.

const IpGeoOverrideSchema = new mongoose.Schema(
  {
    // Single address ("203.0.113.7") or a block ("203.0.113.0/24"). Stored
    // normalized to network/prefix so the same block cannot be added twice.
    cidr: { type: String, required: true, unique: true, index: true },
    // Precomputed IPv4 network + mask, so matching is integer math and never
    // re-parses strings on the request path.
    base: { type: Number, required: true },
    bits: { type: Number, required: true, min: 0, max: 32 },

    city: { type: String, default: "" },
    region: { type: String, default: "" },
    country: { type: String, default: "" },
    countryCode: { type: String, default: "" },
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    timezone: { type: String, default: "" },
    // Shown instead of the city line. Use it to name a shared network so nobody
    // reads it as one client's home address.
    label: { type: String, default: "" },

    note: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "ip_geo_overrides", versionKey: false }
);

export const IpGeoOverride =
  mongoose.models.IpGeoOverride || mongoose.model("IpGeoOverride", IpGeoOverrideSchema);
