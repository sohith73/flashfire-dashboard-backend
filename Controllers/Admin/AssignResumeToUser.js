import { UserModel } from "../../Schema_Models/UserModel.js";
import { ProfileModel } from "../../Schema_Models/ProfileModel.js";
import { buildSummaryForEmail } from "../BuildAiSummary.js";
import mongoose from "mongoose";

function triggerResumeAttachRebuild(email, reason) {
    if (!email) return;
    // Flip summaryStale so the AI Summaries dashboard banner reflects the
    // pending rebuild even if OpenAI is slow / down.
    ProfileModel.findOneAndUpdate(
        { email: String(email).toLowerCase() },
        { $set: { summaryStale: true } },
    ).catch((e) => console.warn(`[resume-attach] flag stale failed ${email}:`, e.message));
    setImmediate(() => {
        buildSummaryForEmail(email, reason)
            .then((r) => {
                if (r?.success) console.log(`[summary-rebuild:${reason}] ok email=${email} model=${r.model} source=${r.source}`);
                else if (r?.skipped) console.log(`[summary-rebuild:${reason}] skipped email=${email} — a build is already running, profile left stale for the sweep`);
                else console.warn(`[summary-rebuild:${reason}] fail email=${email} err=${r?.error}`);
            })
            .catch((e) => console.error(`[summary-rebuild:${reason}] threw email=${email}`, e));
    });
}

/**
 * The one place a resume gets attached to a client. The admin button
 * (POST /admin/assign-resume-to-user) and the auto-link on resume creation
 * (Controllers/Admin/AutoLinkResume.js) both call this, so they cannot drift.
 *
 * Returns { outcome, user, previousResumeId, resumeIndexSynced }, where outcome
 * is "assigned" | "user_not_found" | "already_assigned".
 *
 * `onlyIfUnassigned` is the auto-link guard: the claim on the client is one
 * conditional update, so two resumes created at once for the same client cannot
 * both win, and a client who already has a resume is left alone. The manual
 * path leaves it off and keeps its replace-on-purpose behaviour.
 */
export async function assignResumeToUser(userEmail, resumeId, { onlyIfUnassigned = false } = {}) {
    const user = await UserModel.findOne({ email: userEmail });
    if (!user) return { outcome: "user_not_found" };

    const existingResumeId = user.assignedResumeId;

    const syncResumeIndex = async () => {
        const resumeApiUrl = process.env.RESUME_API_URL || "http://localhost:5000";
        try {
            const updateRes = await fetch(`${resumeApiUrl}/api/update-resume-user-email`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ resumeId, userEmail }),
                signal: AbortSignal.timeout(8000),
            });
            if (!updateRes.ok) {
                console.error("Failed to update ResumeIndex userEmail");
                return false;
            }
            return true;
        } catch (err) {
            console.error("Error updating ResumeIndex:", err);
            return false;
        }
    };

    let updatedUser;
    let resumeIndexSynced;
    if (onlyIfUnassigned) {
        updatedUser = await UserModel.findOneAndUpdate(
            {
                _id: user._id,
                $or: [{ assignedResumeId: null }, { assignedResumeId: "" }, { assignedResumeId: { $exists: false } }],
            },
            { $set: { assignedResumeId: resumeId } },
            { new: true, runValidators: false }
        );
        if (!updatedUser) return { outcome: "already_assigned", user };
        resumeIndexSynced = await syncResumeIndex();
    } else {
        resumeIndexSynced = await syncResumeIndex();
        updatedUser = await UserModel.findOneAndUpdate(
            { email: userEmail },
            { $set: { assignedResumeId: resumeId } },
            { new: true, runValidators: false }
        );
        if (!updatedUser) return { outcome: "user_not_found" };
    }

    triggerResumeAttachRebuild(userEmail, "resume-assign");
    return { outcome: "assigned", user: updatedUser, previousResumeId: existingResumeId, resumeIndexSynced };
}

export default async function AssignResumeToUser(req, res) {
    try {
        const { userEmail, resumeId } = req.body;
        
        if (!userEmail || !resumeId) {
            return res.status(400).json({ 
                success: false, 
                message: "User email and resume ID are required" 
            });
        }

        const result = await assignResumeToUser(userEmail, resumeId);
        if (result.outcome === "user_not_found") {
            return res.status(404).json({ 
                success: false, 
                message: "User not found" 
            });
        }

        const { user: updatedUser, previousResumeId: existingResumeId } = result;
        return res.status(200).json({
            success: true,
            message: existingResumeId 
                ? "Resume replaced successfully" 
                : "Resume assigned successfully",
            user: {
                email: updatedUser.email,
                name: updatedUser.name,
                assignedResumeId: updatedUser.assignedResumeId,
                previousResumeId: existingResumeId
            }
        });
    } catch (error) {
        console.error("Error assigning resume to user:", error);
        res.status(500).json({ 
            success: false, 
            message: "Failed to assign resume",
            error: error.message 
        });
    }
}
