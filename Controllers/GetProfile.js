import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { getAppSettings } from "../Schema_Models/AppSettings.js";

function escapeRegex(s) {
  return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// resolveProfile — same lookup ladder buildSummaryForEmail and
// UpdateChanges.recordRemovalFeedbackAndRebuild use: exact lowercase first,
// then a case-insensitive match for legacy mixed-case profile rows.
// Without the fallback this route 404s on exactly the profiles those two
// WRITE to, so a summary would build fine and then be invisible to both
// consumers (clients-tracking's AI Summary tab and the extension).
async function resolveProfile(email) {
  const lower = String(email).toLowerCase();
  const hit = await ProfileModel.findOne({ email: lower }).lean();
  if (hit) return hit;
  return ProfileModel.findOne({
    email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") },
  }).lean();
}

export default async function GetProfile(req, res) {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const [profile, user] = await Promise.all([
      resolveProfile(email),
      UserModel.findOne({ email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") } })
        .select('removedJobsCount')
        .lean()
    ]);

    if (!profile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const userProfile = {
      ...profile,
      removedJobsCount: user?.removedJobsCount || 0
    };

    // Fallback to the admin-managed global OpenAI key when the per-client
    // profile has none. Extension reads userProfile.openaiKey on every
    // reloadProfile call, so the swap is invisible to the client code.
    if (!userProfile.openaiKey || !String(userProfile.openaiKey).trim()) {
      try {
        const settings = await getAppSettings();
        const globalKey = (settings?.globalOpenaiKey || "").trim();
        if (globalKey) userProfile.openaiKey = globalKey;
      } catch (e) {
        console.warn("GetProfile global-key fallback failed:", e.message);
      }
    }

    return res.json({
      message: "Profile retrieved successfully",
      userProfile,
    });
  } catch (error) {
    console.error("GetProfile error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
}
