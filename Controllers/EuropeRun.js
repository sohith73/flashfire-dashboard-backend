import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { ClientPaymentLookup } from "../Schema_Models/ClientPaymentLookup.js";
import { getEuropeClients } from "../Utils/europeClients.js";
import { postToDiscord, sendEuropeRunReminder } from "../Utils/europeRunReminder.js";

// GET /autopilot/europe-clients   (ops key)
// The clients the Autopilot "Run Europe clients" button works through, with
// the roles and places to search. See Utils/europeClients.js for the rules.
export const listEuropeClients = async (_req, res) => {
  try {
    const data = await getEuropeClients({ ProfileModel, ClientPaymentLookup });
    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("listEuropeClients failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /autopilot/europe-run/notify   (ops key)   body: { text }
// Relays a short status line from the Autopilot app to the team's Discord
// channel ("click Allow", "solve the robot check", "done: 87 pushed"). The
// webhook URL stays on the server.
export const notifyEuropeRun = async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ success: false, message: "text is required" });
  if (text.length > 1900) return res.status(422).json({ success: false, message: "text is longer than 1900 characters" });
  try {
    const r = await postToDiscord(text);
    if (!r.sent) return res.status(503).json({ success: false, message: r.reason });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("notifyEuropeRun failed:", error.message);
    res.status(502).json({ success: false, message: `Discord did not accept the message: ${error.message}` });
  }
};

// POST /autopilot/europe-run/remind   (ops key)
// Sends today's reminder now. For testing the webhook without waiting for 3 AM.
export const remindEuropeRun = async (_req, res) => {
  try {
    const r = await sendEuropeRunReminder();
    if (!r.sent) return res.status(r.reason === "no clients" ? 200 : 503).json({ success: r.reason === "no clients", ...r });
    res.status(200).json({ success: true, ...r });
  } catch (error) {
    console.error("remindEuropeRun failed:", error.message);
    res.status(502).json({ success: false, message: error.message });
  }
};
