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

export default async function AssignResumeToUser(req, res) {
    try {
        const { userEmail, resumeId } = req.body;
        
        if (!userEmail || !resumeId) {
            return res.status(400).json({ 
                success: false, 
                message: "User email and resume ID are required" 
            });
        }

        const user = await UserModel.findOne({ email: userEmail });
        
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                message: "User not found" 
            });
        }

        const existingResumeId = user.assignedResumeId;
        
        const resumeApiUrl = process.env.RESUME_API_URL || "http://localhost:5000";
        try {
            const updateRes = await fetch(`${resumeApiUrl}/api/update-resume-user-email`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ resumeId, userEmail })
            });
            
            if (!updateRes.ok) {
                console.error("Failed to update ResumeIndex userEmail");
            }
        } catch (err) {
            console.error("Error updating ResumeIndex:", err);
            
        }
        const updatedUser = await UserModel.findOneAndUpdate(
            { email: userEmail },
            { $set: { assignedResumeId: resumeId } },
            { new: true, runValidators: false }
        );
        
        if (!updatedUser) {
            return res.status(404).json({ 
                success: false, 
                message: "User not found after update" 
            });
        }

        triggerResumeAttachRebuild(userEmail, "resume-assign");
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

