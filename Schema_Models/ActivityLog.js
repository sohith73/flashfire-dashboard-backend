import mongoose from "mongoose";

const ActorSchema = new mongoose.Schema(
  {
    email: { type: String, default: "" },
    name: { type: String, default: "" },
    role: { type: String, default: "" },
    source: { type: String, default: "" }, // "optimizer" | "dashboard" | "extension" | "system"
  },
  { _id: false }
);

// Structured IP geolocation. `location` above stays as the display string so
// existing readers keep working; these fields let the UI show a flag and say
// how much the answer can be trusted. Raw per-provider votes live in
// ip_geo_cache, keyed by IP, rather than being copied onto every event.
const GeoSchema = new mongoose.Schema(
  {
    city: { type: String, default: "" }, // blank when providers disagreed on it
    region: { type: String, default: "" },
    country: { type: String, default: "" },
    countryCode: { type: String, default: "" }, // ISO 3166-1 alpha-2
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
    timezone: { type: String, default: "" },
    label: { type: String, default: "" }, // set by a pinned override
    source: { type: String, default: "" }, // "consensus" | "override" | "single"
    confidence: { type: String, default: "" }, // "high" | "medium" | "low"
  },
  { _id: false }
);

const ActivityLogSchema = new mongoose.Schema(
  {
    actor: { type: ActorSchema, default: () => ({}) },
    action: { type: String, required: true, index: true },
    category: { type: String, default: "system", index: true },
    targetType: { type: String, default: "", index: true },
    targetId: { type: String, default: "" },
    targetLabel: { type: String, default: "" },
    summary: { type: String, default: "" },
    diff: { type: mongoose.Schema.Types.Mixed, default: null },
    context: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: "" },
    location: { type: String, default: "" }, // "City, Region, Country" resolved from IP (best-effort)
    geo: { type: GeoSchema, default: null },
    userAgent: { type: String, default: "" },
    severity: { type: String, default: "info", enum: ["info", "warning", "critical"] },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { collection: "activity_logs", versionKey: false }
);

ActivityLogSchema.index({ createdAt: -1, _id: -1 });
ActivityLogSchema.index({ "actor.email": 1, createdAt: -1 });
ActivityLogSchema.index({ category: 1, createdAt: -1 });
ActivityLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const ActivityLog =
  mongoose.models.ActivityLog || mongoose.model("ActivityLog", ActivityLogSchema);
