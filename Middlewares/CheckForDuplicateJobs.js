import { JobModel } from "../Schema_Models/JobModel.js";
import { sanitizeJobTitle, normalizeWhitespace } from "../Utils/jobTitle.js";
import { inspectJobLink, SHARED_FORM_COMPANY_LIMIT } from "../Utils/jobLinkKey.js";

export default async function CheckForDuplicateJobs(req, res, next) {
    let {jobDetails,userDetails } = req.body;
    // console.log(req.body)
    try {
       jobDetails = jobDetails || {};
       const normalizedTitle = sanitizeJobTitle(jobDetails.jobTitle);
       const normalizedCompany = normalizeWhitespace(jobDetails.companyName);
       jobDetails.jobTitle = normalizedTitle;

       if (!normalizedTitle) {
            return res.status(400).json({ message: "Job title is required and must be at most 50 characters." });
       }

       // Same LINK for this client. Checked first because it is the stronger
       // signal: one shared application form (a Tally link, a company portal)
       // is used for several roles, so the title+company test below waves every
       // one of them through and the operator ends up with the same URL five
       // times. Skipped automatically when the link carries no identity.
       let linkInfo = null;
       try {
           linkInfo = await inspectJobLink(JobModel, userDetails.email, jobDetails.joblink);
       } catch (e) {
           console.warn("inspectJobLink failed, allowing the push:", e.message);
       }
       if (linkInfo && linkInfo.companyCount >= SHARED_FORM_COMPANY_LIMIT) {
            return res.status(403).json({
                message: `This link is already recorded under ${linkInfo.companyCount} different companies across ${linkInfo.clientCount} clients, so it is a generic application form rather than a specific job. Use the employer's own posting URL.`,
                reason: 'SHARED_APPLICATION_FORM',
                companyCount: linkInfo.companyCount,
                clientCount: linkInfo.clientCount
            });
       }
       const dupByLink = linkInfo?.duplicateForClient;
       if (dupByLink) {
            return res.status(403).json({
                message: `This job link was already added for this client (${dupByLink.jobTitle} at ${dupByLink.companyName}).`,
                reason: 'DUPLICATE_LINK',
                existing: {
                    jobID: dupByLink.jobID,
                    jobTitle: dupByLink.jobTitle,
                    companyName: dupByLink.companyName,
                    currentStatus: dupByLink.currentStatus,
                    dateAdded: dupByLink.dateAdded
                }
            });
       }

       let existingJobDetails = await JobModel.findOne({
            userID: userDetails.email,
            jobTitle: { $regex: new RegExp("^" + normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") },
            companyName: { $regex: new RegExp("^" + normalizedCompany.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }
        });
       if(existingJobDetails){
            //req.body.editjob = true;
            return res.status(403).json({ message : 'Job Already Exist  !', reason: 'DUPLICATE_TITLE_COMPANY' });
       }
       else {
            next();
       }
       
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Error checking for duplicate jobs", error: error.message });
    }
}