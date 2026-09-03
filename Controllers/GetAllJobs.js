import { JobModel } from "../Schema_Models/JobModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import mongoose from "mongoose";
import { computeJobTimes } from "../Utils/jobActivityTime.js";

export default async function GetAllJobs(req, res) {
    try {
        // Check MongoDB connection status before proceeding
        if (mongoose.connection.readyState !== 1) {
            console.error("GetAllJobs error: MongoDB not connected. State:", mongoose.connection.readyState);
            return res.status(503).json({ 
                message: "Database connection unavailable. Please try again in a moment.",
                error: "Service temporarily unavailable"
            });
        }

        const userEmail = (req.body?.email || req.body?.userDetails?.email || req.email || '').toLowerCase();

        if (!userEmail) {
            return res.status(400).json({ message: "User email not found" });
        }

        // Optional pagination (defaults preserve old behavior if not provided)
        const page = Math.max(parseInt(req.query?.page || req.body?.page || '1', 10), 1);
        const limit = Math.max(parseInt(req.query?.limit || req.body?.limit || '0', 10), 0); // 0 means no limit
        const skip = limit > 0 ? (page - 1) * limit : 0;

        // Fields: exclude heavy payloads explicitly
        const query = { userID: userEmail };
        const projection = '-jobDescription -optimizedResume.resumeData';

        // Sort by updatedAt desc (most recently updated first) so moved jobs stay at top
        let cursor = JobModel.find(query)
            .select(projection)
            .lean({ virtuals: false, getters: false });

        if (limit > 0) {
            cursor = cursor.skip(skip).limit(limit);
        }

        const allJobsRaw = await cursor;
        
        // Ordering used to run through a local locale-string parser that assumed
        // MM/DD whenever the first number was <= 12. The collection is a mix of
        // en-US (M/D, uppercase meridiem), en-IN (D/M, lowercase meridiem) and
        // ISO, so that assumption silently threw a large slice of the cards into
        // the wrong month - "1/5/2026" (1 May, en-IN) sorted as 5 January.
        //
        // Utils/jobActivityTime.js now owns this. It reads creation time from
        // the ObjectId (exact, no parsing), disambiguates the remaining strings
        // on the meridiem case, and clamps anything impossible back to the
        // creation time. See the header comment there for the measurements.
        const nowMs = Date.now();
        const withTimes = allJobsRaw.map((job) => ({ job, times: computeJobTimes(job, nowMs) }));

        withTimes.sort((a, b) => {
            if (b.times.activityAt !== a.times.activityAt) {
                return b.times.activityAt - a.times.activityAt;
            }
            // Same instant: fall back to insert order, newest first.
            return b.job._id.toString().localeCompare(a.job._id.toString());
        });

        // Strip extensionCode only (secret). Keep addedBy for timeline ("Added by ...").
        //
        // The *Ms fields are the sortable form of the locale strings above. They
        // are additive: every existing consumer of dateAdded / updatedAt keeps
        // working untouched, and anything that needs to ORDER cards should read
        // activityAt instead of re-parsing a string that cannot be parsed
        // reliably without this file's disambiguation rules.
        const allJobs = withTimes.map(({ job, times }) => {
            const j = { ...job, _id: job._id.toString() };
            delete j.extensionCode;
            j.createdAtMs = times.createdAtMs;
            j.updatedAtMs = times.updatedAtMs;
            j.appliedAtMs = times.appliedAtMs;
            j.activityAt = times.activityAt;
            return j;
        });

        res.status(200).json({
            message: 'All Jobs List',
            allJobs,
            count: allJobs.length,
            userEmail
        });
    } catch (error) {
        console.error("GetAllJobs error:", error);
        
        // Handle specific MongoDB errors
        if (error.name === 'MongoNetworkTimeoutError' || error.name === 'MongoServerSelectionError') {
            return res.status(503).json({ 
                message: "Database connection timeout. Please try again in a moment.",
                error: "Service temporarily unavailable"
            });
        }
        
        if (error.name === 'MongoNetworkError') {
            return res.status(503).json({ 
                message: "Database network error. Please try again in a moment.",
                error: "Service temporarily unavailable"
            });
        }
        
        // Generic error response
        res.status(500).json({ 
            message: "Failed to fetch jobs",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
}
