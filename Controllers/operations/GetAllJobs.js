import { JobModel } from "../../Schema_Models/JobModel.js";
import { computeJobTimes } from "../../Utils/jobActivityTime.js";

export default async function GetAllJobsOPS(req,res) {
    let {email}= req.body;
    try {
        email = (email || '').toLowerCase();

        // Optional pagination
        const page = Math.max(parseInt(req.query?.page || req.body?.page || '1', 10), 1);
        const limit = Math.max(parseInt(req.query?.limit || req.body?.limit || '0', 10), 0);
        const skip = limit > 0 ? (page - 1) * limit : 0;

        const query = { userID: email };
        const projection = '-jobDescription -optimizedResume.resumeData';

        // Fetch all jobs first (we'll sort by updatedAt in JavaScript since it's stored as string)
        let cursor = JobModel.find(query)
            .select(projection)
            .lean({ virtuals: false, getters: false });

        if (limit > 0) {
            cursor = cursor.skip(skip).limit(limit);
        }

        const allJobsRaw = await cursor;
        
        // Ordering is delegated to Utils/jobActivityTime.js, which the client
        // dashboard also uses. This file used to carry its own copy of a parser
        // that read "MM/DD unless the first number is > 12" - wrong for every
        // en-IN row, which is the majority of the collection since Oct 2025.
        // Two copies of the rule meant operations and the client could see the
        // same cards in different orders.
        const nowMs = Date.now();
        const withTimes = allJobsRaw.map((job) => ({ job, times: computeJobTimes(job, nowMs) }));

        withTimes.sort((a, b) => {
            if (b.times.activityAt !== a.times.activityAt) {
                return b.times.activityAt - a.times.activityAt;
            }
            return b.job._id.toString().localeCompare(a.job._id.toString());
        });

        const allJobs = withTimes.map(({ job, times }) => ({
            ...job,
            _id: job._id.toString(),
            createdAtMs: times.createdAtMs,
            updatedAtMs: times.updatedAtMs,
            appliedAtMs: times.appliedAtMs,
            activityAt: times.activityAt
        }));
        
        res.status(200).json({
            message : 'all Jobs List',
            allJobs ,
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Failed to fetch jobs" });
    }
}
