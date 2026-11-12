import Operations from "../../Schema_Models/Operations.js";
import { UserModel } from "../../Schema_Models/UserModel.js";
import { AutopilotCreds } from "../../Schema_Models/AutopilotCreds.js";
import { ClientTrackingModel } from "../../Schema_Models/ClientTrackingModel.js";
import { operatorManagesClient } from "../../Utils/operatorAccess.js";

// Do two hand-typed names refer to the same person?
//
// Both sides are free text typed by different people into different systems,
// and the live data shows every way that goes wrong: DashboardTracking carries
// "Sarah" on 107 clients and "Sarah " - trailing space - on another 47, the
// Operations collection has "sushmitha" in lowercase, and a lead field is
// sometimes run together with something else, as in "sarahali".
//
// So: strip everything that is not a letter, fold the case, and compare the
// first NAME_MATCH_CHARS letters. That accepts "Sarah" == "Sarah " ==
// "sarahali" == "Sarah K." while still keeping the real names apart - the two
// managers in service, Sarah and Sonali, differ at the third letter, and no
// operator name is a prefix of another (asserted in the tests).
//
// The min() matters for short names: "asif" is four letters, so comparing a
// fixed five would never match it against itself. Below three letters there is
// not enough to be confident, so it is not a match at all - better to show the
// prompt to nobody than to the wrong manager.
const NAME_MATCH_CHARS = 5;

function nameKey(raw) {
    return String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
}

function sameName(a, b) {
    const x = nameKey(a);
    const y = nameKey(b);
    if (!x || !y) return false;
    const n = Math.min(x.length, y.length, NAME_MATCH_CHARS);
    if (n < 3) return false;
    return x.slice(0, n) === y.slice(0, n);
}

// POST /operations/jr-creds-status   body: { operatorEmail, clientEmail }
//
// Answers one question for the dashboard: does this client still need their
// JobRight login saved before the autopilot can work them unattended?
//
// WHY THE SERVER DECIDES, AND NOT THE BROWSER
// The operator "session" in this app lives in a zustand store persisted to
// localStorage, so `role === "operations"` is a value the person at the
// keyboard can type in their own devtools. A client who did that would see any
// operator-only UI that trusts it. So this route re-establishes the identity
// against the database on every call, and the prompt renders off THIS
// response rather than off local state: a client gets 403, receives no
// payload, and therefore has nothing to render. The password likewise only
// exists in the response - it is never a constant in the bundle.
//
// The check is deliberately two-sided:
//   1. operatorEmail must be a real Operations document. That collection only
//      accepts @flashfirehq addresses (see its schema), so a client address
//      can never match.
//   2. that operator must actually manage this client. Without this, one
//      known operator address would unlock every client on the platform.
//      Admins skip it, because they legitimately work across all clients.
export default async function JrCredsStatus(req, res) {
    try {
        const operatorEmail = String(req.body?.operatorEmail || "").toLowerCase().trim();
        const clientEmail = String(req.body?.clientEmail || "").toLowerCase().trim();

        if (!operatorEmail.includes("@") || !clientEmail.includes("@")) {
            return res.status(400).json({
                success: false,
                error: "BAD_INPUT",
                message: "operatorEmail and clientEmail are required",
            });
        }

        // Same answer for "not an operator" and "not your client": a 403 that
        // distinguishes them lets someone enumerate which operator owns whom.
        const deny = () =>
            res.status(403).json({ success: false, error: "NOT_AN_OPERATOR" });

        const operator = await Operations.findOne({ email: operatorEmail })
            .select("email name role managedUsers")
            .lean();
        if (!operator) return deny();

        const client = await UserModel.findOne({ email: clientEmail }).select("_id").lean();
        if (!client) return deny();

        if (!operatorManagesClient(operator, client._id)) return deny();

        // WHO IS THIS PROMPT FOR
        // Only the dashboard manager (team lead) who owns this client, per
        // bsc: the person who would actually go and create the account. Every
        // other operator can work the client perfectly well without being told
        // about a JobRight account they are not responsible for, and a prompt
        // that appears for everyone is a prompt everyone learns to dismiss.
        //
        // Admins are let through because they oversee every client and are the
        // ones chasing this when a manager has not done it.
        //
        // The team lead lives in the DashboardTracking collection, written by
        // the applications-monitor backend and read here through the same
        // shared URI - see Schema_Models/ClientTrackingModel.js.
        if (operator.role !== "admin") {
            const tracking = await ClientTrackingModel.findOne({ email: clientEmail })
                .select("dashboardTeamLeadName")
                .lean();
            const lead = String(tracking?.dashboardTeamLeadName || "").trim();
            // No team lead assigned means nobody owns this client's setup, so
            // there is nobody to prompt. Reported rather than silently false so
            // the gap is visible if anyone goes looking.
            if (!lead || !sameName(lead, operator.name)) {
                return res.status(200).json({
                    success: true,
                    clientEmail,
                    needsSetup: false,
                    reason: lead ? "not-this-client-dashboard-manager" : "no-dashboard-manager-assigned",
                });
            }
        }

        const creds = await AutopilotCreds.findOne({ clientEmail })
            .select("jrEmail jrPassword")
            .lean();

        // Mirrors the condition the autopilot itself gates auto-login on:
        //   if creds.get("jrEmail") and creds.get("jrPassword"):
        // A row that exists with either field blank is NOT set up, so reporting
        // on the row's existence alone would tell the operator everything is
        // fine while runs keep failing at the login step.
        const hasEmail = !!String(creds?.jrEmail || "").trim();
        const hasPassword = !!String(creds?.jrPassword || "").trim();
        const needsSetup = !hasEmail || !hasPassword;

        return res.status(200).json({
            success: true,
            clientEmail,
            needsSetup,
            // What is already there, so the prompt can say "password is saved,
            // the email is not" instead of asking for both again.
            hasEmail,
            hasPassword,
            // Only travels when there is something to set up, and only to a
            // caller that just proved it manages this client.
            ...(needsSetup
                ? {
                      jobrightUrl: "https://jobright.ai/login",
                      suggestedEmail: clientEmail,
                      suggestedPassword: "Jobhunt@2026",
                  }
                : {}),
        });
    } catch (error) {
        console.error("JrCredsStatus failed:", error);
        return res.status(500).json({ success: false, error: "INTERNAL", message: error.message });
    }
}
