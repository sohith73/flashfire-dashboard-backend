import { UserModel } from "../Schema_Models/UserModel.js";
import { creditReferralOnPlan } from "../Utils/referralCredit.js";

function normalizePortfolioUrl(raw) {
  let url = (raw || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

function planSelectUserDetailsPayload(user) {
  if (!user) return null;
  return {
    email: user.email,
    name: user.name,
    planLimit: user.planLimit,
    planType: user.planType,
    resumeLink: user.resumeLink,
    coverLetters: user.coverLetters,
    optimizedResumes: user.optimizedResumes,
    transcript: user.transcript,
    portfolioLinks: user.portfolioLinks || [],
    userType: user.userType,
  };
}

export default async function PlanSelect(req, res) {
  console.log(req.body)
  try {
    const {
      resumeLink,
      planType,
      planLimit,
      userDetails, 
      optimizedResumeEntry,
      coverLetterEntry,
      transcriptEntry,   // ✅ new
      deleteBaseResume,
      deleteOptimizedResume,
      deleteCoverLetter,
      deleteTranscript,   // ✅ new
      portfolioLinkEntry,
      deletePortfolioLink,
      portfolioLinkUpdate,
    } = req.body;

    if (!userDetails?.email) {
      return res.status(400).json({ message: "Missing user email" });
    }

    const isOperationsPlanRoute =
      typeof req.originalUrl === "string" && req.originalUrl.includes("/operations/plans/select");

    const hasPortfolioMutation =
      portfolioLinkEntry ||
      deletePortfolioLink ||
      (portfolioLinkUpdate && (portfolioLinkUpdate.originalUrl || portfolioLinkUpdate.filterUrl));

    if (hasPortfolioMutation && !isOperationsPlanRoute) {
      return res.status(403).json({ message: "Portfolio links can only be updated from the operations dashboard" });
    }

    // --- Defensive: normalize legacy resumeLink type (string -> array of objects) ---
    try {
      const existing = await UserModel.findOne({ email: userDetails.email }).lean();
      if (existing && typeof existing.resumeLink === "string" && existing.resumeLink.trim() !== "") {
        const legacyUrl = existing.resumeLink;
        const legacyName = legacyUrl.split("/").pop() || "resume.pdf";
        await UserModel.updateOne(
          { email: userDetails.email },
          {
            $set: {
              resumeLink: [
                {
                  name: legacyName,
                  link: legacyUrl,
                  createdAt: new Date(),
                },
              ],
            },
          }
        );
      } else if (existing && !Array.isArray(existing.resumeLink)) {
        // If it's any other non-array type (null/object), coerce to [] to avoid $push errors
        await UserModel.updateOne(
          { email: userDetails.email },
          { $set: { resumeLink: [] } }
        );
      }
    } catch (e) {
      // Do not fail the request for normalization issues; proceed with best-effort
      console.warn("resumeLink normalization warning:", e?.message || e);
    }

    // --- Build $set with only defined values ---
    const setFields = {};
    if (typeof planType !== "undefined") setFields.planType = planType;
    if (typeof planLimit !== "undefined") setFields.planLimit = planLimit;

    // --- Normalize entries ---
    const normalize = (e) =>
      e
        ? {
            name: e.name || 'unnamed',
            url: e.url || e.link || e.optimizedResumeLink || e.coverLetterLink || "",
            companyName: e.companyName ?? "",
            jobRole: e.jobRole ?? "",
            jobId: e.jobId ?? "",
            jobLink: e.jobLink ?? "",
            createdAt: new Date(),
          }
        : null;

    const normOptimized = normalize(optimizedResumeEntry);
    const normCover     = normalize(coverLetterEntry);
    const normTranscript= normalize(transcriptEntry);

    // --- Build update ops ---
    const updateOps = {};
    if (Object.keys(setFields).length) updateOps.$set = setFields;

    const pushOps = {};
    const pullOps = {};

    // ✅ Base resume
    if (typeof resumeLink !== "undefined" && resumeLink) {
      let resumeUrl = "";
      if (typeof resumeLink === "string") {
        resumeUrl = resumeLink;
      } else if (typeof resumeLink === "object" && resumeLink.link) {
        resumeUrl = resumeLink.link;
      }

      if (resumeUrl && !resumeUrl.includes("undefined") && resumeUrl.trim() !== "") {
        const resumeEntry = {
          name: resumeLink.name || resumeUrl.split("/").pop() || "resume.pdf",
          createdAt: new Date(),
          link: resumeUrl,
        };
        pushOps.resumeLink = { $each: [resumeEntry] };
      }
    }

    // ✅ Optimized resumes / Cover letters
    if (normOptimized && normOptimized.url) {
      pushOps.optimizedResumes = { $each: [normOptimized] };
    }
    if (normCover && normCover.url) {
      pushOps.coverLetters = { $each: [normCover] };
    }

    // ✅ Transcripts
    if (normTranscript && normTranscript.url) {
      pushOps.transcript = { $each: [normTranscript] };
    }

    // ✅ Handle deletions
    if (deleteBaseResume) {
      if (deleteBaseResume.link) {
        pullOps.resumeLink = { link: deleteBaseResume.link };
      } else if (deleteBaseResume.name) {
        pullOps.resumeLink = { name: deleteBaseResume.name };
      }
    }
    if (deleteOptimizedResume) {
      if (deleteOptimizedResume.url) {
        pullOps.optimizedResumes = { url: deleteOptimizedResume.url };
      } else if (deleteOptimizedResume.jobId) {
        pullOps.optimizedResumes = { jobId: deleteOptimizedResume.jobId };
      }
    }
    if (deleteCoverLetter) {
      if (deleteCoverLetter.url) {
        pullOps.coverLetters = { url: deleteCoverLetter.url };
      } else if (deleteCoverLetter.jobId) {
        pullOps.coverLetters = { jobId: deleteCoverLetter.jobId };
      }
    }
    if (deleteTranscript) {
      if (deleteTranscript.url) {
        pullOps.transcript = { url: deleteTranscript.url };
      } else if (deleteTranscript.name) {
        pullOps.transcript = { name: deleteTranscript.name };
      }
    }

    // ✅ Portfolio links (operations route only — enforced above)
    if (portfolioLinkEntry && isOperationsPlanRoute) {
      const u = normalizePortfolioUrl(portfolioLinkEntry.url || portfolioLinkEntry.link);
      if (!u) {
        return res.status(400).json({ message: "Invalid portfolio URL" });
      }
      pushOps.portfolioLinks = {
        $each: [
          {
            name: (portfolioLinkEntry.name || "Portfolio link").trim() || "Portfolio link",
            url: u,
            createdAt: new Date(),
          },
        ],
      };
    }

    if (deletePortfolioLink && isOperationsPlanRoute) {
      if (deletePortfolioLink.url) {
        pullOps.portfolioLinks = { url: deletePortfolioLink.url };
      } else if (deletePortfolioLink.name) {
        pullOps.portfolioLinks = { name: deletePortfolioLink.name };
      }
    }

    if (Object.keys(pushOps).length) updateOps.$push = pushOps;
    if (Object.keys(pullOps).length) updateOps.$pull = pullOps;

    let appliedPortfolioInPlace = false;
    if (isOperationsPlanRoute && portfolioLinkUpdate) {
      const origUrl = portfolioLinkUpdate.originalUrl || portfolioLinkUpdate.filterUrl;
      if (origUrl) {
        const before = await UserModel.findOne({ email: userDetails.email });
        if (!before) return res.status(404).json({ message: "User not found" });
        const links = [...(before.portfolioLinks || [])];
        const idx = links.findIndex((l) => l.url === origUrl);
        if (idx === -1) return res.status(404).json({ message: "Portfolio link not found" });
        if (portfolioLinkUpdate.url != null && String(portfolioLinkUpdate.url).trim() !== "") {
          const nu = normalizePortfolioUrl(portfolioLinkUpdate.url);
          if (!nu) return res.status(400).json({ message: "Invalid portfolio URL" });
          links[idx].url = nu;
        }
        if (typeof portfolioLinkUpdate.name === "string" && portfolioLinkUpdate.name.trim() !== "") {
          links[idx].name = portfolioLinkUpdate.name.trim();
        }
        await UserModel.updateOne(
          { email: userDetails.email },
          { $set: { portfolioLinks: links } }
        );
        appliedPortfolioInPlace = true;
      }
    }

    if (!Object.keys(updateOps).length) {
      if (appliedPortfolioInPlace) {
        const refreshed = await UserModel.findOne({ email: userDetails.email });
        if (!refreshed) return res.status(404).json({ message: "User not found" });
        return res.status(200).json({
          message: "Updated successfully",
          userDetails: planSelectUserDetailsPayload(refreshed),
        });
      }
      return res.status(400).json({ message: "Nothing to update" });
    }

    // --- Perform update ---
    const user = await UserModel.findOneAndUpdate(
      { email: userDetails.email },
      updateOps,
      { new: true, runValidators: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    // Fire-and-forget: sync to client-tracking if 2+ days since dashboard creation
    const baseUrl = process.env.CLIENT_TRACKING_API_BASE_URL;
    const apiKey = process.env.CLIENT_TRACKING_INTERNAL_KEY;
    if (baseUrl && apiKey) {
      const syncDoc = (documentType, url, fileName) => {
        fetch(`${baseUrl}/api/internal/sync-document-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          body: JSON.stringify({ email: userDetails.email?.toLowerCase(), documentType, url, fileName }),
          signal: AbortSignal.timeout(5000),
        }).catch((err) => console.warn('[sync-document-upload]', err.message));
      };
      if (pushOps.resumeLink) {
        const url = typeof resumeLink === 'object' && resumeLink?.link ? resumeLink.link : (typeof resumeLink === 'string' ? resumeLink : '');
        const fileName = (typeof resumeLink === 'object' && resumeLink?.name) ? resumeLink.name : (url ? url.split('/').pop() : 'resume.pdf') || 'resume.pdf';
        if (url) syncDoc('resume', url, fileName);
      }
      if (pushOps.coverLetters && normCover?.url) {
        syncDoc('coverLetter', normCover.url, normCover.name || 'cover letter');
      }
    }

    // Fire-and-forget: if this save put the client on a paid plan and they
    // named a referrer at onboarding, credit that referrer their bonus
    // applications. Idempotent, so re-saving a plan cannot pay twice, and it
    // never rejects - a referral problem must not fail a plan update.
    if (typeof planType !== "undefined") {
      creditReferralOnPlan(userDetails.email).catch((e) =>
        console.warn("[referralCredit]", e?.message || e),
      );
    }

    return res.status(200).json({
      message: "Updated successfully",
      userDetails: planSelectUserDetailsPayload(user),
    });
  } catch (err) {
    console.error("selectPlanAndUploads error:", err);
    return res.status(500).json({ message: "Server error" });
  }
}


// import { UserModel } from "../Schema_Models/UserModel.js";

// export default async function PlanSelect(req, res) {
//   console.log(req.body)
//   try {
//     const {
//       // base resume (with metadata)
//       resumeLink,

//       // plan updates (optional)
//       planType,
//       planLimit,

//       // identity
//       userDetails, // must contain email

//       // entries with metadata (either or both optional)
//       optimizedResumeEntry, // { jobRole, companyName, url, jobId?, jobLink? }
//       coverLetterEntry,     // { jobRole, companyName, url, jobId?, jobLink? }

//       // 🔴 new: deletion requests
//       deleteBaseResume,      // expects { link } or { name }
//       deleteOptimizedResume, // expects { url } or { jobId }
//       deleteCoverLetter,     // expects { url } or { jobId }
//     } = req.body;

//     if (!userDetails?.email) {
//       return res.status(400).json({ message: "Missing user email" });
//     }

//     // --- Build $set with only defined values ---
//     const setFields = {};
//     if (typeof planType !== "undefined") setFields.planType = planType;
//     if (typeof planLimit !== "undefined") setFields.planLimit = planLimit;

//     // --- Normalize entries for push ---
//     const normalize = (e) =>
//       e
//         ? {
//             name: e.name || '',
//             url: e.url || e.optimizedResumeLink || e.coverLetterLink || "",
//             companyName: e.companyName ?? "",
//             jobRole: e.jobRole ?? "",
//             jobId: e.jobId ?? "",
//             jobLink: e.jobLink ?? "",
//             createdAt: new Date(),
//           }
//         : null;

//     const normOptimized = normalize(optimizedResumeEntry);
//     const normCover = normalize(coverLetterEntry);

//     // --- Build update operations ---
//     const updateOps = {};
//     if (Object.keys(setFields).length) updateOps.$set = setFields;

//     const pushOps = {};
//     const pullOps = {};

//     // ✅ Handle base resume upload
//     if (typeof resumeLink !== "undefined" && resumeLink) {
//       let resumeUrl = "";

//       if (typeof resumeLink === "string") {
//         resumeUrl = resumeLink;
//       } else if (typeof resumeLink === "object" && resumeLink.link) {
//         resumeUrl = resumeLink.link;
//       }

//       if (
//         resumeUrl &&
//         !resumeUrl.includes("undefined") &&
//         resumeUrl.trim() !== ""
//       ) {
//         const resumeEntry = {
//           name: resumeLink.name, //resumeUrl.split("/").pop() || "resume.pdf",
//           createdAt: new Date(),
//           link: resumeUrl,
//         };
//         pushOps.resumeLink = { $each: [resumeEntry] };
//       }
//     }

//     // ✅ Handle new optimized resume / cover letter
//     if (normOptimized && normOptimized.url) {
//       pushOps.optimizedResumes = { $each: [normOptimized] };
//     }
//     if (normCover && normCover.url) {
//       pushOps.coverLetters = { $each: [normCover] };
//     }

//     // ✅ Handle deletions
//     if (deleteBaseResume) {
//       if (deleteBaseResume.link) {
//         pullOps.resumeLink = { link: deleteBaseResume.link };
//       } else if (deleteBaseResume.name) {
//         pullOps.resumeLink = { name: deleteBaseResume.name };
//       }
//     }
//     if (deleteOptimizedResume) {
//       if (deleteOptimizedResume.url) {
//         pullOps.optimizedResumes = { url: deleteOptimizedResume.url };
//       } else if (deleteOptimizedResume.jobId) {
//         pullOps.optimizedResumes = { jobId: deleteOptimizedResume.jobId };
//       }
//     }
//     if (deleteCoverLetter) {
//       if (deleteCoverLetter.url) {
//         pullOps.coverLetters = { url: deleteCoverLetter.url };
//       } else if (deleteCoverLetter.jobId) {
//         pullOps.coverLetters = { jobId: deleteCoverLetter.jobId };
//       }
//     }

//     if (Object.keys(pushOps).length) updateOps.$push = pushOps;
//     if (Object.keys(pullOps).length) updateOps.$pull = pullOps;

//     if (!Object.keys(updateOps).length) {
//       return res.status(400).json({ message: "Nothing to update" });
//     }

//     // --- Perform update ---
//     const user = await UserModel.findOneAndUpdate(
//       { email: userDetails.email },
//       updateOps,
//       { new: true, runValidators: true }
//     );

//     if (!user) return res.status(404).json({ message: "User not found" });

//     return res.status(200).json({
//       message: "Updated successfully",
//       userDetails: {
//         email: user.email,
//         name: user.name,
//         planLimit: user.planLimit,
//         planType: user.planType,
//         resumeLink: user.resumeLink,
//         coverLetters: user.coverLetters,
//         optimizedResumes: user.optimizedResumes,
//         userType: user.userType,
//       },
//     });
//   } catch (err) {
//     console.error("selectPlanAndUploads error:", err);
//     return res.status(500).json({ message: "Server error" });
//   }
// }
