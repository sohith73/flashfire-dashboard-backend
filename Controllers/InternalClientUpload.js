import multer from "multer";
import { uploadFile } from "../Utils/storageService.js";
import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { buildSummaryForEmail } from "./BuildAiSummary.js";
import dotenv from "dotenv";

dotenv.config();

function triggerSummaryRebuild(email, reason) {
  if (!email) return;
  setImmediate(() => {
    buildSummaryForEmail(email, reason)
      .then((r) => {
        if (r?.success) console.log(`[summary-rebuild:${reason}] ok email=${email} model=${r.model}`);
        else if (r?.skipped) console.log(`[summary-rebuild:${reason}] skipped email=${email} — a build is already running, profile left stale for the sweep`);
        else console.warn(`[summary-rebuild:${reason}] fail email=${email} err=${r?.error}`);
      })
      .catch((e) => console.error(`[summary-rebuild:${reason}] threw email=${email}`, e));
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX, and TXT files are allowed'), false);
    }
  }
});

export const uploadClientDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: "No file uploaded" 
      });
    }

    const { email, documentType } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false,
        message: "Email is required" 
      });
    }

    if (!documentType || !['resume', 'coverLetter'].includes(documentType)) {
      return res.status(400).json({ 
        success: false,
        message: "documentType must be 'resume' or 'coverLetter'" 
      });
    }

    const clientName = email.replace(/[^a-zA-Z0-9._-]/g, '_');

    const uploadResult = await uploadFile(req.file.buffer, {
      folder: 'flashfirejobs',
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      clientName,
      fileType: documentType,
    });

    if (!uploadResult.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to upload file",
        error: uploadResult.error,
      });
    }

    const fileUrl = uploadResult.url;
    const fileName = req.file.originalname;

    const profileUpdateField = documentType === 'resume' ? 'resumeUrl' : 'coverLetterUrl';
    
    await ProfileModel.findOneAndUpdate(
      { email: email.toLowerCase() },
      { 
        $set: { 
          [profileUpdateField]: fileUrl 
        } 
      },
      { upsert: false }
    );

    if (documentType === 'resume') {
      const resumeEntry = {
        name: fileName,
        link: fileUrl,
        createdAt: new Date(),
      };

      await UserModel.findOneAndUpdate(
        { email: email.toLowerCase() },
        { 
          $push: { 
            resumeLink: resumeEntry 
          } 
        },
        { upsert: false }
      );
    }

    if (documentType === 'coverLetter') {
      const coverLetterEntry = {
        name: fileName,
        url: fileUrl,
        createdAt: new Date(),
      };

      await UserModel.findOneAndUpdate(
        { email: email.toLowerCase() },
        { 
          $push: { 
            coverLetters: coverLetterEntry 
          } 
        },
        { upsert: false }
      );
    }

    // Fire-and-forget: sync to client-tracking if 2+ days since dashboard creation
    const baseUrl = process.env.CLIENT_TRACKING_API_BASE_URL;
    const apiKey = process.env.CLIENT_TRACKING_INTERNAL_KEY;
    if (baseUrl && apiKey) {
      fetch(`${baseUrl}/api/internal/sync-document-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ email: email.toLowerCase(), documentType, url: fileUrl, fileName }),
        signal: AbortSignal.timeout(5000),
      }).catch((err) => console.warn('[sync-document-upload]', err.message));
    }

    // Resume change → mark summary stale and fire-and-forget rebuild so the
    // grader sees the new resume content without admin intervention.
    if (documentType === 'resume') {
      ProfileModel.findOneAndUpdate(
        { email: email.toLowerCase() },
        { $set: { summaryStale: true } },
      ).catch((e) => console.warn(`[resume-upload] flag stale failed ${email}:`, e.message));
      triggerSummaryRebuild(email.toLowerCase(), 'resume-upload');
    }

    res.json({
      success: true,
      url: fileUrl,
      fileName: fileName,
      documentType: documentType,
      storage: uploadResult.storage || 'r2',
      message: `${documentType === 'resume' ? 'Resume' : 'Cover Letter'} uploaded and synced successfully`,
    });

  } catch (error) {
    console.error("Internal client upload error:", error);
    res.status(500).json({ 
      success: false,
      message: error.message || "Failed to upload file" 
    });
  }
};

export const getClientDocuments = async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({ 
        success: false,
        message: "Email is required" 
      });
    }

    const profile = await ProfileModel.findOne({ email: email.toLowerCase() }).lean();
    const user = await UserModel.findOne({ email: email.toLowerCase() }).lean();

    const documents = {
      resumeUrl: profile?.resumeUrl || null,
      coverLetterUrl: profile?.coverLetterUrl || null,
      linkedinUrl: profile?.linkedinUrl || null,
      resumeLinks: user?.resumeLink || [],
      coverLetters: user?.coverLetters || [],
      optimizedResumes: user?.optimizedResumes || [],
      transcripts: user?.transcript || [],
    };

    res.json({
      success: true,
      documents,
    });

  } catch (error) {
    console.error("Get client documents error:", error);
    res.status(500).json({ 
      success: false,
      message: error.message || "Failed to fetch documents" 
    });
  }
};

export const updateClientOptimizationStatus = async (req, res) => {
  try {
    const { email } = req.params;
    const { linkedinUrl, resumeUrl, coverLetterUrl } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false,
        message: "Email is required" 
      });
    }

    const updateFields = {};
    if (linkedinUrl !== undefined) updateFields.linkedinUrl = linkedinUrl;
    if (resumeUrl !== undefined) updateFields.resumeUrl = resumeUrl;
    if (coverLetterUrl !== undefined) updateFields.coverLetterUrl = coverLetterUrl;

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "No fields to update" 
      });
    }

    const updatedProfile = await ProfileModel.findOneAndUpdate(
      { email: email.toLowerCase() },
      { $set: updateFields },
      { new: true, upsert: false }
    );

    if (!updatedProfile) {
      return res.status(404).json({ 
        success: false,
        message: "Profile not found" 
      });
    }

    res.json({
      success: true,
      message: "Profile updated successfully",
      profile: {
        linkedinUrl: updatedProfile.linkedinUrl,
        resumeUrl: updatedProfile.resumeUrl,
        coverLetterUrl: updatedProfile.coverLetterUrl,
      },
    });

  } catch (error) {
    console.error("Update client optimization error:", error);
    res.status(500).json({ 
      success: false,
      message: error.message || "Failed to update profile" 
    });
  }
};

export { upload };
