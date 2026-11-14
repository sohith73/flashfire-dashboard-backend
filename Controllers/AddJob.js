import mongoose from 'mongoose'
import { JobModel } from '../Schema_Models/JobModel.js';
import { ProfileModel } from '../Schema_Models/ProfileModel.js';
import { isClientLocked } from './operations/ClientOperations.js';
import { getExclusionBlockReason } from '../Utils/exclusionGuard.js';
import { sanitizeJobTitle } from '../Utils/jobTitle.js';
import { checkCap, detectOvershoot, checkPlanCap, enforcePlanCapPostInsert } from '../Utils/dailyCapGuard.js';
import { jobLinkKey, inspectJobLink, SHARED_FORM_COMPANY_LIMIT } from '../Utils/jobLinkKey.js';
import { classifyApplyUrl } from '../Utils/applyUrlPolicy.js';
import { ukSponsorPushBlock } from '../Utils/ukVisaSponsor.js';
import { usSponsorPushBlock } from '../Utils/usVisaSponsor.js';
import { auSponsorPushBlock } from '../Utils/auVisaSponsor.js';
import { euSponsorPushBlock } from '../Utils/euVisaSponsor.js';
import { companyAllowlistBlock } from '../Utils/companyAllowlist.js';
import { initialAutoOptimization } from '../Utils/autoOptimizationState.js';

// Clamp the judge's verdict into the shape JobModel.aiDecision expects.
// Returns null when there is nothing worth storing, so a push from an older
// extension build simply leaves the field unset.
function sanitizeAiDecision(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // 0-100, integers only. A score outside that range means a bug upstream,
    // and storing it would make the operator-facing card lie.
    const score = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
    };
    const text = (v, max) => {
        const t = String(v ?? '').trim();
        return t ? t.slice(0, max) : null;
    };
    const when = new Date(raw.judgedAt);
    const out = {
        reason: text(raw.reason, 500),
        score: score(raw.score),
        matchedRole: text(raw.matchedRole, 120),
        jrScore: score(raw.jrScore),
        model: text(raw.model, 60),
        judgedAt: Number.isNaN(when.getTime()) ? new Date() : when,
    };
    // A verdict with no reason and no scores carries no information.
    if (!out.reason && out.score === null && out.jrScore === null) return null;
    return out;
}

export default async function AddJob(req, res) {
    let { jobDetails, userDetails, role, operationsEmail, operationsName, extensionCode, source, aiDecision } = req.body;

    try {
        jobDetails = jobDetails || {};
        jobDetails.jobTitle = sanitizeJobTitle(jobDetails?.jobTitle);
        if (!jobDetails.jobTitle) {
            return res.status(400).json({
                success: false,
                message: "Job title is required and must be at most 50 characters."
            });
        }

        // The apply-URL policy (aggregator links vs excluded employers) lives
        // in Utils/applyUrlPolicy.js so the job-API imports answer to exactly
        // the same rules as this route. See that file for why the two
        // refusals are kept apart.
        const { verdict: linkVerdict, host } = classifyApplyUrl(jobDetails?.joblink);

        if (linkVerdict === 'BLOCKED_SOURCE') {
            return res.status(403).json({
                success: false,
                error: 'BLOCKED_SOURCE',
                message: `Job board/aggregator link (${host || 'unparseable URL'}) — provide the original employer apply URL.`,
            });
        }
        if (linkVerdict === 'EXCLUDED_EMPLOYER') {
            return res.status(403).json({
                success: false,
                error: 'EXCLUDED_EMPLOYER',
                message: `This employer is on the do-not-apply list (${host || 'link'}) — the link is fine, the job is skipped by policy.`,
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

        // "Only these companies" (Utils/companyAllowlist.js). Operator pushes
        // only, same as the sponsor rule below. The extension files the 403
        // under "blocked" and it never spends a slot of the daily cap.
        if (isOpsRole && clientForExclusions) {
            let allowBlock;
            try {
                allowBlock = await companyAllowlistBlock({
                    email: clientForExclusions,
                    companyName: jobDetails?.companyName,
                });
            } catch (e) {
                console.error('companyAllowlistBlock failed:', e.message);
                return res.status(503).json({
                    success: false,
                    error: 'COMPANY_ALLOWLIST_CHECK_FAILED',
                    message: 'Could not read this client\'s company list (DB unavailable). Push refused, try again shortly.',
                });
            }
            if (allowBlock) {
                console.log(JSON.stringify({
                    event: 'company.allowlist.block',
                    client: clientForExclusions,
                    company: jobDetails?.companyName || '',
                    ts: new Date().toISOString(),
                }));
                return res.status(allowBlock.status).json({
                    success: false,
                    error: allowBlock.error,
                    message: allowBlock.message,
                });
            }
        }

        // "UK visa sponsors only" (Utils/ukVisaSponsor.js). Operator pushes
        // only: a client adding a job to their own board is never second-
        // guessed. The extension files this 403 under "blocked" and moves on,
        // and it never spends a slot of the daily cap.
        if (isOpsRole && clientForExclusions) {
            let sponsorBlock;
            try {
                sponsorBlock = await ukSponsorPushBlock({
                    email: clientForExclusions,
                    companyName: jobDetails?.companyName,
                });
            } catch (e) {
                console.error('ukSponsorPushBlock failed:', e.message);
                return res.status(503).json({
                    success: false,
                    error: e.code === 'SPONSOR_REGISTER_EMPTY' ? 'SPONSOR_REGISTER_EMPTY' : 'SPONSOR_CHECK_FAILED',
                    message: e.code === 'SPONSOR_REGISTER_EMPTY'
                        ? e.message
                        : 'Could not check the UK sponsor register (DB unavailable). Push refused, try again shortly.',
                });
            }
            if (sponsorBlock) {
                console.log(JSON.stringify({
                    event: 'uk.sponsor.block',
                    client: clientForExclusions,
                    company: jobDetails?.companyName || '',
                    reason: sponsorBlock.sponsor?.reason || null,
                    ts: new Date().toISOString(),
                }));
                return res.status(sponsorBlock.status).json({
                    success: false,
                    error: sponsorBlock.error,
                    message: sponsorBlock.message,
                });
            }
        }

        // "US H-1B sponsors only" (Utils/usVisaSponsor.js). Same contract as the
        // UK rule above; the lookup is in memory, so it costs no query.
        if (isOpsRole && clientForExclusions) {
            let usBlock;
            try {
                usBlock = await usSponsorPushBlock({
                    email: clientForExclusions,
                    companyName: jobDetails?.companyName,
                    jobDescription: jobDetails?.jobDescription,
                });
            } catch (e) {
                console.error('usSponsorPushBlock failed:', e.message);
                return res.status(503).json({
                    success: false,
                    error: e.code === 'US_SPONSOR_DATA_NOT_LOADED' ? 'US_SPONSOR_DATA_NOT_LOADED' : 'SPONSOR_CHECK_FAILED',
                    message: e.code === 'US_SPONSOR_DATA_NOT_LOADED'
                        ? e.message
                        : 'Could not check US H-1B sponsors (DB unavailable). Push refused, try again shortly.',
                });
            }
            if (usBlock) {
                console.log(JSON.stringify({
                    event: 'us.sponsor.block',
                    client: clientForExclusions,
                    company: jobDetails?.companyName || '',
                    reason: usBlock.sponsor?.reason || null,
                    quote: usBlock.posting?.quote || null,
                    ts: new Date().toISOString(),
                }));
                return res.status(usBlock.status).json({
                    success: false,
                    error: usBlock.error,
                    message: usBlock.message,
                });
            }
        }

        // "Australia visa sponsors only" (Utils/auVisaSponsor.js). Same contract
        // as the UK and US rules above; the lookup is in memory.
        if (isOpsRole && clientForExclusions) {
            let auBlock;
            try {
                auBlock = await auSponsorPushBlock({
                    email: clientForExclusions,
                    companyName: jobDetails?.companyName,
                    jobDescription: jobDetails?.jobDescription,
                });
            } catch (e) {
                console.error('auSponsorPushBlock failed:', e.message);
                return res.status(503).json({
                    success: false,
                    error: e.code === 'AU_SPONSOR_DATA_NOT_LOADED' ? 'AU_SPONSOR_DATA_NOT_LOADED' : 'SPONSOR_CHECK_FAILED',
                    message: e.code === 'AU_SPONSOR_DATA_NOT_LOADED'
                        ? e.message
                        : 'Could not check Australian visa sponsors (DB unavailable). Push refused, try again shortly.',
                });
            }
            if (auBlock) {
                console.log(JSON.stringify({
                    event: 'au.sponsor.block',
                    client: clientForExclusions,
                    company: jobDetails?.companyName || '',
                    reason: auBlock.sponsor?.reason || null,
                    quote: auBlock.posting?.quote || null,
                    ts: new Date().toISOString(),
                }));
                return res.status(auBlock.status).json({
                    success: false,
                    error: auBlock.error,
                    message: auBlock.message,
                });
            }
        }

        // "Europe visa sponsors only" (Utils/euVisaSponsor.js). The job's location
        // decides which list applies (NL: IND register, IE: permit holders).
        if (isOpsRole && clientForExclusions) {
            let euBlock;
            try {
                euBlock = await euSponsorPushBlock({
                    email: clientForExclusions,
                    companyName: jobDetails?.companyName,
                    jobDescription: jobDetails?.jobDescription,
                    jobLocation: jobDetails?.jobLocation,
                });
            } catch (e) {
                console.error('euSponsorPushBlock failed:', e.message);
                return res.status(503).json({
                    success: false,
                    error: e.code === 'EU_SPONSOR_DATA_NOT_LOADED' ? 'EU_SPONSOR_DATA_NOT_LOADED' : 'SPONSOR_CHECK_FAILED',
                    message: e.code === 'EU_SPONSOR_DATA_NOT_LOADED'
                        ? e.message
                        : 'Could not check European visa sponsors (DB unavailable). Push refused, try again shortly.',
                });
            }
            if (euBlock) {
                console.log(JSON.stringify({
                    event: 'eu.sponsor.block',
                    client: clientForExclusions,
                    company: jobDetails?.companyName || '',
                    reason: euBlock.sponsor?.reason || null,
                    quote: euBlock.posting?.quote || null,
                    ts: new Date().toISOString(),
                }));
                return res.status(euBlock.status).json({
                    success: false,
                    error: euBlock.error,
                    message: euBlock.message,
                });
            }
        }

        // Always set an explicit auto-optimization state so ops can see what happened.
        jobDetails.autoOptimization = initialAutoOptimization(jobDetails.jobDescription);

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
            // Why the extension picked this job. Sanitised rather than spread:
            // /addjob is a public endpoint, so every field is re-derived here
            // with its own type and length cap instead of trusting the body.
            // Operations-only - a client-submitted job never carries one.
            const ai = sanitizeAiDecision(aiDecision);
            if (ai) jobDetails.aiDecision = ai;
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