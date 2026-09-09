import { ClientPaymentLookup } from "../Schema_Models/ClientPaymentLookup.js";

// GET /api/clients/tracking-status
//
// Consumed by the Flashfire Autopilot desktop app: maps every client email to
// the operations status kept in dashboardtrackings (status "active"/"inactive"
// + isPaused), so the app can show and filter the same Active/Inactive state
// the operations dashboard shows. Read-only, no payment or credential fields.
export const getClientTrackingStatus = async (_req, res) => {
  try {
    const docs = await ClientPaymentLookup.find({})
      .select("email status isPaused")
      .lean();
    res.status(200).json({
      success: true,
      count: docs.length,
      data: docs
        .filter((d) => d.email)
        .map((d) => ({
          email: String(d.email).toLowerCase().trim(),
          status: String(d.status || "").toLowerCase() || "unknown",
          isPaused: d.isPaused === true
        }))
    });
  } catch (error) {
    console.error("tracking-status failed:", error);
    res.status(500).json({ success: false, message: "Failed to fetch tracking status", error: error.message });
  }
};
