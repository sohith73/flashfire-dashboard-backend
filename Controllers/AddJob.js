import mongoose from 'mongoose'
import { JobModel } from '../Schema_Models/JobModel.js';
import { ProfileModel } from '../Schema_Models/ProfileModel.js';
import { isClientLocked } from './operations/ClientOperations.js';
import { getExclusionBlockReason } from '../Utils/exclusionGuard.js';
import { sanitizeJobTitle } from '../Utils/jobTitle.js';
import { checkCap, detectOvershoot, checkPlanCap, enforcePlanCapPostInsert } from '../Utils/dailyCapGuard.js';
import { jobLinkKey, inspectJobLink, SHARED_FORM_COMPANY_LIMIT } from '../Utils/jobLinkKey.js';

export default async function AddJob(req, res) {
    let { jobDetails, userDetails, role, operationsEmail, operationsName, extensionCode, source } = req.body;

    try {
        jobDetails = jobDetails || {};
        jobDetails.jobTitle = sanitizeJobTitle(jobDetails?.jobTitle);
        if (!jobDetails.jobTitle) {
            return res.status(400).json({
                success: false,
                message: "Job title is required and must be at most 50 characters."
            });
        }

        // Job-board / aggregator links are not allowed — the dashboard needs
        // the ORIGINAL employer apply URL. Previous scraper versions dropped
        // these before push (src/adapters/jobright.js → isLinkedInApplyUrl);
        // the new JR-Direct extension flow lost that filter, so re-enforce it
        // here (the single choke point every push goes through). Mirrors the
        // old BLOCKED_HOST_RX (valid URLs) + BLOCKED_SUBSTRING_RX (fallback).
        const joblinkRaw = String(jobDetails?.joblink || '');
        // jobright.ai included: a /jobs/info/<id> link means the employer apply
        // URL never resolved — reject it (the dashboard needs the real URL).
        const BLOCKED_HOST_RX = /(^|\.)(jobright\.ai|linkedin\.com|dice\.com|indeed\.com|lifeattiktok\.com|dataannotation\.tech|jobs\.apple\.com|humana\.wd5\.myworkdayjobs\.com)$/i;
        const BLOCKED_SUBSTRING_RX = /(jobright\.ai|linkedin\.com|dice\.com|indeed\.com|lifeattiktok\.com|dataannotation\.tech|dickssportinggoods)/i;
        let blockedSource = false;
        try {
            blockedSource = BLOCKED_HOST_RX.test(new URL(joblinkRaw).hostname);
        } catch {
            blockedSource = BLOCKED_SUBSTRING_RX.test(joblinkRaw);
        }
        if (blockedSource) {
            return res.status(403).json({
                success: false,
                error: 'BLOCKED_SOURCE',
                message: 'Job board/aggregator links (LinkedIn, Dice, Indeed, etc.) are not allowed — provide the original employer apply URL.'
            });
        }

        const isOpsRole = role === 'operations' || role === 'operator';
        const isOperations =
            isOpsRole ||
            (operationsEmail && String(operationsEmail).endsWith('@flashfirehq'));

        if (isOperations && jobDetails?.userID) {
            const lockCheck = await isClientLocked(jobDetails.userID);
            if (lockCheck.isLocked) {
                return res.status(403).json({
                    success: false,
                    message: lockCheck.message || "Client is in lock period"
                });
            }
        }

        // Same link already added for this client.
        //
        // This lives in the CONTROLLER, not only in CheckForDuplicateJobs,
        // because /operations/jobs routes straight here with no middleware at
        // all — that path had no duplicate protection of any kind. Running it
        // before the cap checks also means a duplicate never consumes a slot
        // from the client's daily or lifetime allowance.
        //
        // Returns null when the link carries no identity, so a blank or
        // placeholder URL is never reported as a duplicate of another blank one.
        if (jobDetails?.userID) {
            // One round trip answers both link questions. Fails OPEN: this is a
            // spam filter, not a limit, so a database hiccup must let a real
            // push through rather than block the operator.
            let linkInfo = null;
            try {
                linkInfo = await inspectJobLink(JobModel, jobDetails.userID, jobDetails.joblink);
            } catch (e) {
                console.warn('inspectJobLink failed, allowing the push:', e.message);
            }

            // (a) SHARED APPLICATION FORM. One URL recorded under many unrelated
            //     employers is not a job posting, it is a generic form that
            //     dozens of fake listings funnel into. Checked before the
            //     per-client duplicate because it is the worse problem: the
            //     client-scoped rule cannot see it at all, and one such form had
            //     already consumed 139 real applications across 27 clients.
            if (linkInfo && linkInfo.companyCount >= SHARED_FORM_COMPANY_LIMIT) {
                return res.status(409).json({
                    success: false,
                    error: 'SHARED_APPLICATION_FORM',
                    message: `This link is already recorded under ${linkInfo.companyCount} different companies across ${linkInfo.clientCount} clients, so it is a generic application form rather than a specific job. Use the employer's own posting URL.`,
                    companyCount: linkInfo.companyCount,
                    clientCount: linkInfo.clientCount,
                    sampleCompanies: linkInfo.companies.slice(0, 8)
                });
            }

            // (b) Same link, same client.
            const dupByLink = linkInfo?.duplicateForClient;
            if (dupByLink) {
                return res.status(409).json({
                    success: false,
                    error: 'DUPLICATE_LINK',
                    message: `This job link was already added for this client (${dupByLink.jobTitle} at ${dupByLink.companyName}).`,
                    existing: {
                        jobID: dupByLink.jobID,
                        jobTitle: dupByLink.jobTitle,
                        companyName: dupByLink.companyName,
                        currentStatus: dupByLink.currentStatus,
                        dateAdded: dupByLink.dateAdded
                    }
                });
            }
        }

        const clientForExclusions = jobDetails?.userID || userDetails?.email;

        // Lifetime PLAN cap. Hard cap on TOTAL applications for this client
        // across all time, applied to both ops- and user-added jobs. Runs
        // BEFORE the daily cap so a client at lifetime limit can't push even
        // if the daily window has room. Skipped silently when no client is
        // resolvable (existing BAD_INPUT path below catches that for ops).
        if (clientForExclusions) {
            let planCheck;
            try {
                planCheck = await checkPlanCap(clientForExclusions);
            } catch (e) {
                console.error('dailyCapGuard.checkPlanCap failed:', e.message);
                return res.status(503).json({
                    success: false,
                    error: 'PLAN_CAP_CHECK_FAILED',
                    message: 'Could not verify plan limit (DB unavailable). Push refused — try again shortly.',
                });
            }
            if (!planCheck.allowed) {
                console.log(JSON.stringify({
                    event: 'plan.cap.hit',
                    client: clientForExclusions,
                    planType: planCheck.planType,
                    cap: planCheck.cap,
                    baseCap: planCheck.baseCap,
                    referralBonus: planCheck.referralBonus,
                    referralCount: planCheck.referralCount,
                    addonBonus: planCheck.addonBonus,
                    addonCount: planCheck.addonCount,
                    count: planCheck.count,
                    source: planCheck.source,
                    operator: operationsName || operationsEmail || (isOpsRole ? 'unknown-ops' : 'user'),
                    ts: new Date().toISOString(),
                }));
                return res.status(403).json({
                    success: false,
                    error: planCheck.reason || 'PLAN_LIMIT_REACHED',
                    message: planCheck.message,
                    cap: planCheck.cap,
                    baseCap: planCheck.baseCap,
                    referralBonus: planCheck.referralBonus,
                    referralCount: planCheck.referralCount,
                    addonBonus: planCheck.addonBonus,
                    addonCount: planCheck.addonCount,
                    current: planCheck.count,
                    remaining: 0,
                    planType: planCheck.planType,
                });
            }
        }

        // Daily-cap gate. Production rules (covered by dailyCapGuard.js):
        //   1. Ops pushes MUST resolve a client email — reject up-front
        //      otherwise (used to silently skip the cap check).
        //   2. Cap defaults to 30/day when admin hasn't set one — no
        //      unbounded route.
        //   3. DB errors propagate as 503 (fail-closed). Old code logged
        //      and let the push through.
        //   4. After insert, detectOvershoot() logs a structured warning
        //      when concurrent inserts raced past the limit.
        //   5. Cap counts ops jobs only since the 10 PM IST window reset.
        if (isOpsRole) {
            if (!clientForExclusions) {
                return res.status(400).json({
                    success: false,
                    error: 'BAD_INPUT',
                    message: 'Operations push requires jobDetails.userID or userDetails.email — refusing without a client to attribute the push to.',
                });
            }
            let capCheck;
            try {
                capCheck = await checkCap(clientForExclusions);
            } catch (e) {
                console.error('dailyCapGuard.checkCap failed:', e.message, e.stack);
                if (e.code === 'BAD_INPUT') {
                    return res.status(400).json({ success: false, error: 'BAD_INPUT', message: e.message });
                }
                return res.status(503).json({
                    success: false,
                    error: 'CAP_CHECK_FAILED',
                    message: 'Could not verify daily cap (DB unavailable). Push refused — try again shortly.',
                });
            }
            if (!capCheck.allowed) {
                console.log(JSON.stringify({
                    event: 'cap.hit',
                    client: clientForExclusions,
                    cap: capCheck.cap,
                    count: capCheck.count,
                    isDefault: capCheck.isDefault,
                    operator: operationsName || operationsEmail || 'unknown',
                    ts: new Date().toISOString(),
                }));
                return res.status(403).json({
                    success: false,
                    error: capCheck.reason || 'TARGET_REACHED',
                    message: capCheck.message,
                    cap: capCheck.cap,
                    current: capCheck.count,
                    remaining: 0,
                    isDefaultCap: capCheck.isDefault,
                });
            }
            // Stash the snapshot so we can detectOvershoot() after insert.
            req._capSnapshot = capCheck;
        }

        if (clientForExclusions) {
            const blockReason = await getExclusionBlockReason(
                clientForExclusions,
                jobDetails?.companyName,
                jobDetails?.jobLocation
            );
            if (blockReason === "BLOCKED_COMPANY") {
                return res.status(403).json({
                    success: false,
                    error: "BLOCKED_COMPANY",
                    message: "This company is blocked for this client.",
                });
            }
            if (blockReason === "BLOCKED_LOCATION") {
                return res.status(403).json({
                    success: false,
                    error: "BLOCKED_LOCATION",
                    message: "This location is blocked for this client.",
                });
            }
        }
        
        // Always set an explicit auto-optimization state so ops can see what happened.
        if (jobDetails.jobDescription?.trim()) {
            jobDetails.autoOptimization = { status: 'pending', attempts: 0 };
        } else {
            jobDetails.autoOptimization = {
                status: 'skipped',
                attempts: 0,
                error: 'Skipped: missing job description'
            };
        }

        // Second-stage screening: only jobs pushed by the JR-Direct extension
        // auto-judge flow get re-judged against the REAL employer-site text.
        // The extension judges on JobRight's own description only (no scraper);
        // the secondJudgeWorker opens the actual posting and re-grades it.
        // Requires a joblink for the scraper to open — otherwise skip.
        const isExtensionJob = String(source || '').trim().toLowerCase() === 'jr-direct-extension';
        const jl = String(jobDetails?.joblink || '').trim();
        // Only queue real employer/ATS URLs — jobright/indeed/linkedin can't be
        // scraped for full text (login/bot walls), so the second judge would
        // have nothing valid to grade. The worker re-checks this defensively.
        const scrapeableLink =
            !!jl &&
            !/jobright\.ai/i.test(jl) &&
            !/indeed\.com/i.test(jl) &&
            !/(^|\.)linkedin\.com/i.test(jl);
        if (isExtensionJob && scrapeableLink) {
            jobDetails.secondJudge = { status: 'pending', attempts: 0 };
        }

        const opsDisplayName =
            (operationsName && String(operationsName).trim()) ||
            (userDetails?.name && String(userDetails.name).trim()) ||
            'operations';

        if (isOpsRole) {
            jobDetails.createdByRole = 'operations';
            jobDetails.timeline = ['Added'];
            jobDetails.operatorName = opsDisplayName;
            jobDetails.operatorEmail = operationsEmail || 'operations@flashfirehq';
            jobDetails.addedBy = opsDisplayName;
            // Tag the 5-digit operator code so per-operator aggregation
            // works on JobModel.extensionCode (today-stats / activity).
            const code = String(extensionCode || '').trim();
            if (/^\d{5}$/.test(code)) jobDetails.extensionCode = code;
        } else {
            jobDetails.createdByRole = 'user';
            jobDetails.timeline = ['Added by user'];
            jobDetails.operatorName = 'user';
            jobDetails.operatorEmail = 'user@flashfirehq';
        }

        // Stamp the canonical key so the next add can find this one. Computed
        // here rather than in a schema hook so every write path is explicit
        // about it and a missing key is visible in review, not silent.
        jobDetails.joblinkKey = jobLinkKey(jobDetails.joblink);

        const createdJob = await JobModel.create(jobDetails);

        // HARD plan-cap enforcement post-insert. Concurrent requests can each
        // pass the pre-check at cap-1 and BOTH insert (e.g. 1200 cap → 1202).
        // Re-count here; if the inserted job pushed us over the lifetime
        // cap, delete it and return 403 — same outcome as a pre-check reject.
        if (clientForExclusions) {
            try {
                const enforce = await enforcePlanCapPostInsert(clientForExclusions, createdJob._id);
                if (!enforce.kept) {
                    return res.status(403).json({
                        success: false,
                        error: 'PLAN_LIMIT_REACHED',
                        message: `Plan limit reached during race (${enforce.count}/${enforce.cap}). Push refused — this job was rolled back.`,
                        cap: enforce.cap,
                        baseCap: enforce.baseCap,
                        referralBonus: enforce.referralBonus,
                        addonBonus: enforce.addonBonus,
                        current: enforce.count,
                        remaining: 0,
                        planType: enforce.planType,
                        rolledBack: enforce.deleted,
                    });
                }
            } catch (e) {
                // Don't surface the rollback-check failure to the client —
                // job is already inserted, log loudly so ops can audit.
                console.error('enforcePlanCapPostInsert failed:', e.message, e.stack);
            }
        }

        // Post-insert DAILY-cap overshoot detection. Concurrent /addjob
        // requests can both pass pre-check at cap-1 and both insert. Log
        // structured warning so ops can audit. Non-blocking.
        if (req._capSnapshot && clientForExclusions) {
            detectOvershoot(clientForExclusions, req._capSnapshot.cap).catch((err) => {
                console.warn('detectOvershoot threw:', err?.message);
            });
        }

        let NewJobList = await JobModel.find({userID : jobDetails?.userID}).lean();
        
        NewJobList = NewJobList.map(job => ({
            ...job,
            _id: job._id.toString()
        }));
        
        console.log('Job added successfully with _id:', createdJob._id);
        
        return res.status(200).json({
            message: 'job added succesfully',
            NewJobList,
            createdJobId: createdJob._id.toString()
        });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: "Failed to add job", error: error.message });
    }
}