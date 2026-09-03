// controllers/StoreJobAndUserDetails.js
import { JobModel } from "../Schema_Models/JobModel.js";
import { ClientOperationsModel } from "../Schema_Models/ClientOperationsModel.js";
import { isClientLocked } from "./operations/ClientOperations.js";
import { resolveAddedByFromExtensionCode } from "../Utils/resolveAddedByFromExtensionCode.js";
import {
    buildExclusionCheckSets,
    isCompanyBlocked,
    isLocationBlocked,
} from "../Utils/exclusionLists.js";
import { sanitizeJobTitle } from "../Utils/jobTitle.js";
import { checkCap, detectOvershoot, checkPlanCap, enforcePlanCapPostInsert } from "../Utils/dailyCapGuard.js";
import { jobLinkKey, inspectJobLink, SHARED_FORM_COMPANY_LIMIT } from "../Utils/jobLinkKey.js";

/**
 * Normalize job title/company for duplicate check: trim and collapse multiple spaces.
 */
function normalizeString(s) {
    if (!s || typeof s !== 'string') return '';
    return s.trim().replace(/\s+/g, ' ');
}

/** Escape special regex characters for safe use in RegExp. */
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default async function StoreJobAndUserDetails(req, res) {
    console.log(req.body);
    try {
        const b = req.body || {};
        const pickKey = (obj, keys, fallback = "") => {
            for (const k of keys) {
                if (Object.prototype.hasOwnProperty.call(obj, k)) {
                    const v = obj[k];
                    if (v !== undefined && v !== null && String(v).trim() !== "") {
                        return { value: String(v), key: k };
                    }
                }
            }
            return { value: String(fallback), key: null };
        };

        const { value: userID } = pickKey(b, ["userID", "mappedEmail", "_editedBy"], "unknown@flashfirejobs.com");
        const { value: rawJobTitle } = pickKey(b, ["title"], "Untitled Job");
        const jobTitle = sanitizeJobTitle(rawJobTitle);
        const { value: companyName } = pickKey(b, ["companyName"], "unknown");
        const { value: joblink } = pickKey(b, ["applyUrl", "url"], "www.google.com");
        const { value: jobDescriptionHtml } = pickKey(b, ["descriptionHtml"]);

        // Was exact string equality on joblink, which misses every cosmetic
        // variation: ?utm_source=linkedin, a trailing slash and a www. prefix
        // each read as a brand new job. Compare the canonical key instead.
        // Fails open — a spam filter must not block a real push on a DB hiccup.
        let linkInfo = null;
        try {
            linkInfo = await inspectJobLink(JobModel, userID, joblink);
        } catch (e) {
            console.warn("inspectJobLink failed, allowing the push:", e.message);
        }
        if (linkInfo && linkInfo.companyCount >= SHARED_FORM_COMPANY_LIMIT) {
            console.log(`🚫 Shared application form for ${userID} — recorded under ${linkInfo.companyCount} companies. Skipping save.`);
            return res.status(200).json({ success: true, skipped: true, reason: "shared_application_form", companyCount: linkInfo.companyCount });
        }
        const existing = linkInfo?.duplicateForClient;
        if (existing) {
            console.log(`❌ Duplicate job link for user ${userID} (${existing.jobTitle} at ${existing.companyName}). Skipping save.`);
            return res.status(200).json({ success: true, skipped: true, reason: "duplicate" });
        }

        const payload = {
            dateAdded: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            userID,
            jobTitle,
            joblink,
            joblinkKey: jobLinkKey(joblink),
            companyName,
            currentStatus: "saved",
            jobDescription: jobDescriptionHtml, // <-- Use the correctly picked description value
            timeline: ["Added"],
            attachments: []
        };

        // --- STEP 3: LOG THE FINAL PAYLOAD BEFORE CREATING THE DOCUMENT ---
        console.log("Final payload for MongoDB:", payload);

        // await JobModel.create(payload);

        console.log("✅ Successfully saved job for user:", userID);
        return res.status(200).json({ success: true, message: "Job saved successfully" });

    } catch (error) {
        console.error("❌ Error in StoreJobAndUserDetails:", error);
        return res.status(500).json({ success: false, message: error.message, error_details: error.stack });
    }
}


// export async function saveToDashboard(req, res) {
//     try {
//         const {
//             company,
//             description,
//             position,
//             selectedEmails,
//             url
//         } = req.body;

//         if (!selectedEmails || !Array.isArray(selectedEmails) || selectedEmails.length === 0) {
//             return res.status(400).json({
//                 success: false,
//                 message: "The 'selectedEmails' field is required and must be a non-empty array."
//             });
//         }
//         if (!position || !company || !url) {
//             return res.status(400).json({
//                 success: false,
//                 message: "Missing required job details: 'position', 'company', and 'url' are required."
//             });
//         }
//         const jobCreationPromises = selectedEmails.map(email => {
//             const payload = {
//                 // Manually adding all required fields to the payload
//                 dateAdded: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
//                 createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
//                 userID: email.trim(),
//                 jobTitle: position,
//                 joblink: url,
//                 companyName: company,
//                 currentStatus: "saved",
//                 jobDescription: description || "",
//                 timeline: ["Added"],
//                 attachments: []
//             };
//             // console.log("payload : ",payload)
//             return JobModel.create(payload);
//         });
//         const results = await Promise.allSettled(jobCreationPromises);


//         const summary = {
//             saved: 0,
//             skippedAsDuplicate: 0,
//             failedWithError: 0,
//             details: []
//         };

//         results.forEach((result, index) => {
//             const userEmail = selectedEmails[index];
//             if (result.status === 'fulfilled') {
//                 summary.saved++;
//                 summary.details.push({ user: userEmail, status: 'saved', jobId: result.value.jobID });
//             } else {

//                 if (result.reason?.code === 11000) {
//                     summary.skippedAsDuplicate++;
//                     summary.details.push({ user: userEmail, status: 'skipped_duplicate', reason: 'This job link already exists for this user.' });
//                 } else {
//                     summary.failedWithError++;
//                     summary.details.push({ user: userEmail, status: 'failed', reason: result.reason?.message || 'An unknown error occurred.' });
//                     console.error(`❌ Failed to save job for ${userEmail}:`, result.reason);
//                 }
//             }
//         });

//         console.log(`✅ Job saving process complete. Saved: ${summary.saved}, Skipped: ${summary.skippedAsDuplicate}, Failed: ${summary.failedWithError}`);

//         return res.status(200).json({
//             success: true,
//             message: "Job saving process completed.",
//             summary
//         });

//     } catch (error) {
//         console.error("❌ Unhandled error in saveToDashboard controller:", error);
//         return res.status(500).json({
//             success: false,
//             message: "An internal server error occurred.",
//             errorDetails: error.message
//         });
//     }
// }

export async function saveToDashboard(req, res) {
    try {
      //  console.log(req.body);
        const {
            company,
            description,
            position,
            selectedEmails,
            logo,
            url,
            extensionCode,
            operatorEmail,
            location,
        } = req.body;

        // --- Input Validation (no changes here) ---
        if (!selectedEmails || !Array.isArray(selectedEmails) || selectedEmails.length === 0) {
            return res.status(400).json({
                success: false,
                message: "The 'selectedEmails' field is required and must be a non-empty array."
            });
        }
        const sanitizedPosition = sanitizeJobTitle(position);
        if (!sanitizedPosition || !company || !url) {
            return res.status(400).json({
                success: false,
                message: "Missing required job details: 'position', 'company', and 'url' are required."
            });
        }

        const rawExtensionCode =
            extensionCode !== undefined && extensionCode !== null
                ? String(extensionCode).trim()
                : "";
        if (!rawExtensionCode || !/^\d{5}$/.test(rawExtensionCode)) {
            return res.status(400).json({
                success: false,
                error: "EXTENSION_CODE_REQUIRED",
                message:
                    "A valid 5-digit operator code is required. Open the extension and enter your code, then try again."
            });
        }

        const addedByFromCode = await resolveAddedByFromExtensionCode(rawExtensionCode);
        if (!addedByFromCode) {
            return res.status(400).json({
                success: false,
                error: "INVALID_EXTENSION_CODE",
                message:
                    "This code is invalid or no longer active. Re-enter your operator code in the extension."
            });
        }

        // Jobright.ai block commented out - allow jobs from jobright.ai
        // if (url && String(url).toLowerCase().includes('jobright.ai')) {
        //     return res.status(400).json({
        //         success: false,
        //         message: "Jobs from Jobright are not allowed. Please use a different job source."
        //     });
        // }

        const summary = {
            saved: 0,
            skippedAsDuplicate: 0,
            failedWithError: 0,
            details: []
        };

        const locationStr =
            location !== undefined && location !== null ? String(location) : "";

        const trimmedEmails = selectedEmails.map((e) => String(e).trim());
        const emailsLower = trimmedEmails.map((e) => e.toLowerCase());
        const opsDocs = await ClientOperationsModel.find({
            clientEmail: { $in: emailsLower },
        }).lean();
        const opsByEmail = new Map(
            opsDocs.map((d) => [d.clientEmail, d])
        );

        for (const userEmail of trimmedEmails) {
            try {
                const lockCheck = await isClientLocked(userEmail);
                if (lockCheck.isLocked) {
                    summary.failedWithError++;
                    summary.details.push({
                        user: userEmail,
                        status: 'failed',
                        reason: lockCheck.message || "Client is in lock period"
                    });
                    continue;
                }

                const opsDoc = opsByEmail.get(userEmail.toLowerCase());
                const { companySet, locationExactSet, locationTokenSet } =
                    buildExclusionCheckSets(
                        opsDoc?.excludedCompanies,
                        opsDoc?.excludedLocations
                    );

                if (isCompanyBlocked(company, companySet)) {
                    summary.failedWithError++;
                    summary.details.push({
                        user: userEmail,
                        status: "failed",
                        error: "BLOCKED_COMPANY",
                        reason: "Company name is blocked for this client.",
                    });
                    continue;
                }
                if (isLocationBlocked(locationStr, locationExactSet, locationTokenSet)) {
                    summary.failedWithError++;
                    summary.details.push({
                        user: userEmail,
                        status: "failed",
                        error: "BLOCKED_LOCATION",
                        reason: "Location is blocked for this client.",
                    });
                    continue;
                }

                // Lifetime plan cap — TOTAL applications cap per plan.
                let planCheck;
                try {
                    planCheck = await checkPlanCap(userEmail);
                } catch (e) {
                    console.error("dailyCapGuard.checkPlanCap failed (saveToDashboard):", e.message);
                    summary.failedWithError++;
                    summary.details.push({
                        user: userEmail,
                        status: "failed",
                        error: "PLAN_CAP_CHECK_FAILED",
                        reason: "Could not verify plan limit (DB unavailable). Try again shortly.",
                    });
                    continue;
                }
                if (!planCheck.allowed) {
                    console.log(JSON.stringify({
                        event: "plan.cap.hit",
                        path: "saveToDashboard",
                        client: userEmail,
                        planType: planCheck.planType,
                        cap: planCheck.cap,
                        baseCap: planCheck.baseCap,
                        referralBonus: planCheck.referralBonus,
                        referralCount: planCheck.referralCount,
                        addonBonus: planCheck.addonBonus,
                        addonCount: planCheck.addonCount,
                        count: planCheck.count,
                        source: planCheck.source,
                        operator: addedByFromCode,
                        code: rawExtensionCode,
                        ts: new Date().toISOString(),
                    }));
                    summary.failedWithError++;
                    summary.details.push({
                        user: userEmail,
                        status: "failed",
                        error: planCheck.reason || "PLAN_LIMIT_REACHED",
                        reason: planCheck.message,
                        cap: planCheck.cap,
                        baseCap: planCheck.baseCap,
                        referralBonus: planCheck.referralBonus,
                        referralCount: planCheck.referralCount,
                        addonBonus: planCheck.addonBonus,
                        addonCount: planCheck.addonCount,
                        current: planCheck.count,
                        planType: planCheck.planType,
                    });
                    continue;
                }

                // Daily cap gate (saveToDashboard is operator-driven via the
                // 5-digit code → tag every push as createdByRole:'operations').
                // Same guard as /addjob — fail-closed on DB error, log structured
                // event when the cap trips. Each user iteration is independent
                // so one client hitting the cap doesn't block others in the batch.
                let capCheck;
                try {
                    capCheck = await checkCap(userEmail);
                } catch (e) {
                    console.error("dailyCapGuard.checkCap failed (saveToDashboard):", e.message);
                    summary.failedWithError++;
                    summary.details.push({
                        user: userEmail,
                        status: "failed",
                        error: e.code === "BAD_INPUT" ? "BAD_INPUT" : "CAP_CHECK_FAILED",
                        reason: e.code === "BAD_INPUT" ? e.message : "Could not verify daily cap (DB unavailable). Try again shortly.",
                    });
                    continue;
                }
                if (!capCheck.allowed) {
                    console.log(JSON.stringify({
                        event: "cap.hit",
                        path: "saveToDashboard",
                        client: userEmail,
                        cap: capCheck.cap,
                        count: capCheck.count,
                        isDefault: capCheck.isDefault,
                        operator: addedByFromCode,
                        code: rawExtensionCode,
                        ts: new Date().toISOString(),
                    }));
                    summary.failedWithError++;
                    summary.details.push({
                        user: userEmail,
                        status: "failed",
                        error: capCheck.reason || "TARGET_REACHED",
                        reason: capCheck.message,
                        cap: capCheck.cap,
                        current: capCheck.count,
                        isDefaultCap: capCheck.isDefault,
                    });
                    continue;
                }

                const normTitle = normalizeString(sanitizedPosition);
                const normCompany = normalizeString(company);

                // Same LINK first. The title+company test below cannot catch a
                // shared application form used for several roles — one Tally or
                // careers-portal URL under five different titles passes it five
                // times, which is exactly how the same link ended up on five
                // cards for one client.
                let linkInfo2 = null;
                try {
                    linkInfo2 = await inspectJobLink(JobModel, userEmail, url);
                } catch (e) {
                    console.warn('inspectJobLink failed, allowing the push:', e.message);
                }
                if (linkInfo2 && linkInfo2.companyCount >= SHARED_FORM_COMPANY_LIMIT) {
                    console.log(`🚫 Shared application form for ${userEmail} — ${linkInfo2.companyCount} companies. Skipping.`);
                    summary.skippedAsDuplicate++;
                    summary.details.push({
                        user: userEmail,
                        status: 'skipped_duplicate',
                        reason: `Generic application form: this link is already recorded under ${linkInfo2.companyCount} different companies.`
                    });
                    continue;
                }
                const dupLink = linkInfo2?.duplicateForClient;
                if (dupLink) {
                    console.log(`⏩ Duplicate job LINK for user ${userEmail}. Skipping.`);
                    summary.skippedAsDuplicate++;
                    summary.details.push({
                        user: userEmail,
                        status: 'skipped_duplicate',
                        reason: `This job link was already added for this client (${dupLink.jobTitle} at ${dupLink.companyName}).`
                    });
                    continue;
                }

                // Duplicate check: same user + same job title + same company (case-insensitive).
                // Kept as a second net for postings whose URL genuinely differs
                // run to run (e.g. "Unknown URL" fallbacks, per-session tokens).
                const existingJob = await JobModel.findOne({
                    userID: userEmail,
                    jobTitle: { $regex: new RegExp('^' + escapeRegex(normTitle) + '$', 'i') },
                    companyName: { $regex: new RegExp('^' + escapeRegex(normCompany) + '$', 'i') }
                });

                if (existingJob) {
                    console.log(`⏩ Duplicate job found for user ${userEmail} (Same title and company). Skipping.`);
                    summary.skippedAsDuplicate++;
                    summary.details.push({
                        user: userEmail,
                        status: 'skipped_duplicate',
                        reason: 'An identical job (same URL, title, and company) already exists for this user.'
                    });
                    continue;
                }

                // If no duplicate is found, create and save the job.
                // Tag createdByRole='operations' so the cap counter sees these
                // pushes — historically saveToDashboard left the field undefined,
                // which silently bypassed the cap.
                const payload = {
                    dateAdded: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                    createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                    userID: userEmail,
                    jobTitle: sanitizedPosition,
                    joblink: url,
                    joblinkKey: jobLinkKey(url),
                    companyName: company,
                    jobLocation: locationStr || "",
                    companyLogo : logo,
                    currentStatus: "saved",
                    jobDescription: description || "",
                    timeline: ["Added"],
                    attachments: [],
                    operatorName: addedByFromCode,
                    operatorEmail: operatorEmail || 'user@flashfirehq',
                    extensionCode: rawExtensionCode,
                    addedBy: addedByFromCode,
                    createdByRole: 'operations',
                };

                // Always keep explicit status for ops visibility and debugging.
                if (payload.jobDescription?.trim()) {
                    payload.autoOptimization = { status: 'pending', attempts: 0 };
                } else {
                    payload.autoOptimization = {
                        status: 'skipped',
                        attempts: 0,
                        error: 'Skipped: missing job description'
                    };
                }

                const newJob = await JobModel.create(payload);

                // HARD plan-cap rollback for concurrent races — re-count
                // post-insert and delete this job if it pushed past the
                // lifetime cap. Other concurrent inserts roll back their own.
                let rolledBack = false;
                try {
                    const enforce = await enforcePlanCapPostInsert(userEmail, newJob._id);
                    if (!enforce.kept) {
                        rolledBack = true;
                        summary.failedWithError++;
                        summary.details.push({
                            user: userEmail,
                            status: "failed",
                            error: "PLAN_LIMIT_REACHED",
                            reason: `Plan limit reached during race (${enforce.count}/${enforce.cap}) — job rolled back.`,
                            cap: enforce.cap,
                            current: enforce.count,
                            planType: enforce.planType,
                            rolledBack: enforce.deleted,
                        });
                    }
                } catch (e) {
                    console.error("enforcePlanCapPostInsert failed (saveToDashboard):", e.message);
                }
                if (rolledBack) continue;

                // Post-insert daily-cap overshoot detection (non-blocking).
                detectOvershoot(userEmail, capCheck.cap).catch(() => {});
                summary.saved++;
                summary.details.push({
                    user: userEmail,
                    status: 'saved',
                    jobId: newJob._id
                });
                console.log(
                    `✅ Job saved — user: ${userEmail} | addedBy: "${addedByFromCode}" | code: ${rawExtensionCode} | ${sanitizedPosition} @ ${company}`
                );

            } catch (error) {
                summary.failedWithError++;
                summary.details.push({
                    user: userEmail,
                    status: 'failed',
                    reason: error.message || 'An unknown error occurred.'
                });
                console.error(`❌ Failed to save job for ${userEmail}:`, error);
            }
        }

        console.log(
            `✅ Job saving process complete. Saved: ${summary.saved}, Skipped: ${summary.skippedAsDuplicate}, Failed: ${summary.failedWithError}` +
                (summary.saved > 0 ? ` | session addedBy: "${addedByFromCode}"` : '')
        );

        return res.status(200).json({
            success: true,
            message: "Job saving process completed.",
            summary
        });

    } catch (error) {
        console.error("❌ Unhandled error in saveToDashboard controller:", error);
        return res.status(500).json({
            success: false,
            message: "An internal server error occurred.",
            errorDetails: error.message
        });
    }
}

