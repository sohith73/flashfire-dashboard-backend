import { UserModel } from "../../Schema_Models/UserModel.js";

export default async function UnassignResume(req, res) {
    try {
        const { userEmail } = req.body;

        if (!userEmail) {
            return res.status(400).json({ error: "User email is required" });
        }

        const user = await UserModel.findOne({ email: userEmail });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const previousResumeId = user.assignedResumeId || null;

        user.assignedResumeId = null;
        await user.save();

        // The admin UI decides "assigned" from ResumeIndex.userEmail in the resume
        // service, keyed BY EMAIL — not from assignedResumeId. So the unlink MUST
        // clear that email there, always (even when assignedResumeId was already
        // null or points at a stale/different row), or the row snaps right back on
        // the next refresh. Clear by email, and treat a failed clear as a real
        // failure instead of reporting a success the user won't see.
        const resumeApiUrl = process.env.RESUME_API_URL || "http://localhost:5000";
        let resumeServiceCleared = false;
        try {
            const updateRes = await fetch(`${resumeApiUrl}/api/update-resume-user-email`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clearByEmail: userEmail })
            });
            resumeServiceCleared = updateRes.ok;
            if (!updateRes.ok) {
                console.error("Failed to clear ResumeIndex userEmail during unassign:", updateRes.status);
            }
        } catch (err) {
            console.error("Error clearing ResumeIndex userEmail during unassign:", err);
        }

        if (!resumeServiceCleared) {
            return res.status(502).json({
                success: false,
                message: "Could not fully unlink: the resume service was unreachable, so the link may reappear. Please retry.",
                previousResumeId
            });
        }

        res.json({
            success: true,
            message: "Resume unassigned successfully",
            previousResumeId
        });

    } catch (error) {
        console.error("Error unassigning resume:", error);
        res.status(500).json({
            success: false,
            message: "Failed to unassign resume",
            error: error.message
        });
    }
}
