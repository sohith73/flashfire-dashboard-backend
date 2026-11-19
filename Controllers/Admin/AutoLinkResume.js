import crypto from "crypto";
import { UserModel } from "../../Schema_Models/UserModel.js";
import { assignResumeToUser } from "./AssignResumeToUser.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matches the email written on a NEW resume to a client's dashboard login
 * (users.email) and links the resume to that client with the same logic the
 * admin button uses.
 *
 * Only users.email is matched. dashboardtrackings.paymentEmail and crmEmail are
 * deliberately left out: on the staging mirror 253 of 274 payment emails differ
 * from the client's login, 9 payment emails and 3 CRM emails are shared by more
 * than one client, and 1 payment email and 3 CRM emails are another client's
 * login. Matching them would attach resumes to the wrong person.
 *
 * Returns { status, email, name? } with status one of:
 *   linked | no_match | ambiguous | already_linked | invalid_email
 */
export async function autoLinkResume({ email, resumeId }, deps = {}) {
    const { users = UserModel, assign = assignResumeToUser } = deps;
    const cleaned = String(email || "").trim().toLowerCase();
    if (!cleaned || !EMAIL_RE.test(cleaned)) return { status: "invalid_email", email: cleaned };

    // Stored emails are not guaranteed lowercase or trimmed, so compare
    // case-insensitively and tolerate stray whitespace.
    const matches = await users
        .find({ email: { $regex: `^\\s*${escapeRegex(cleaned)}\\s*$`, $options: "i" } })
        .select("email name assignedResumeId")
        .limit(2)
        .lean();

    if (matches.length === 0) return { status: "no_match", email: cleaned };
    if (matches.length > 1) return { status: "ambiguous", email: cleaned };

    const [match] = matches;
    if (match.assignedResumeId) return { status: "already_linked", email: cleaned, name: match.name };

    const result = await assign(match.email, String(resumeId), { onlyIfUnassigned: true });
    if (result.outcome === "already_assigned") return { status: "already_linked", email: cleaned, name: match.name };
    if (result.outcome !== "assigned") return { status: "no_match", email: cleaned };
    return {
        status: "linked",
        email: cleaned,
        name: result.user?.name || match.name,
        resumeIndexSynced: result.resumeIndexSynced,
    };
}

function secretMatches(got) {
    const expected = process.env.ACTIVITY_INGEST_SECRET || "";
    if (!expected || !got) return false;
    const a = crypto.createHash("sha256").update(String(got)).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

/**
 * POST /admin/resume/auto-link, called server to server by the resume-maker
 * backend right after it creates a resume. Gated on the same shared secret as
 * /admin/activity/ingest (x-activity-secret), which both services already hold.
 */
export default async function AutoLinkResumeHandler(req, res) {
    if (!secretMatches(req.headers["x-activity-secret"])) {
        return res.status(401).json({ error: "unauthorized" });
    }
    const { email, resumeId } = req.body || {};
    if (!email || !resumeId) {
        return res.status(400).json({ error: "email and resumeId are required" });
    }
    try {
        return res.status(200).json(await autoLinkResume({ email, resumeId }));
    } catch (err) {
        console.error("[auto-link-resume] failed:", err?.message || err);
        return res.status(500).json({ status: "error", error: "auto-link failed" });
    }
}
