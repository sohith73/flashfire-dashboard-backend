import { JobModel } from "../../Schema_Models/JobModel.js";
import { uploadJSONToR2, getJSONFromR2, extractR2Key, isR2Url } from "../../Utils/r2Storage.js";
import { sectionTitlesFrom } from "../../Utils/sectionTitles.js";
import { enqueueCoverLetterIfEligible } from "../../Utils/coverLetterAutoWriter.js";

// Test endpoint to verify the controller is working
export const testJobController = async (req, res) => {
     try {
          res.json({
               message: "Job controller is working!",
               timestamp: new Date().toISOString(),
               jobId: req.params.id || "no-id-provided"
          });
     } catch (error) {
          console.error("Error in test endpoint:", error);
          res.status(500).json({ error: "Server error" });
     }
};

// get the job description for a particular job id (from body)
export const getJobDescription = async (req, res) => {
     try {
          const { id } = req.body; // expecting { "id": "..." }

          if (!id) {
               return res.status(400).json({ error: "Job ID is required in body" });
          }

          const job = await JobModel.findById(id, "jobDescription");
          // the 2nd param "jobDescription" ensures only that field is returned

          if (!job) {
               return res.status(404).json({ error: "Job not found" });
          }

          return res.json({ jobDescription: job.jobDescription });
     } catch (error) {
          console.error("Error fetching job description:", error);
          return res.status(500).json({ error: "Server error" });
     }
};

// get the job description for a particular job id (from URL params)
export const getJobDescriptionByUrl = async (req, res) => {
     try {
          const { id } = req.params; // expecting id from URL like /getJobDescription/:id

          if (!id) {
               return res.status(400).json({ error: "Job ID is required in URL" });
          }

          const job = await JobModel.findById(id, "jobDescription jobTitle companyName");
          // Return jobDescription, jobTitle, and companyName for context

          if (!job) {
               return res.status(404).json({ error: "Job not found" });
          }

          return res.json({
               jobDescription: job.jobDescription,
               jobTitle: job.jobTitle,
               companyName: job.companyName
          });
     } catch (error) {
          console.error("Error fetching job description by URL:", error);
          return res.status(500).json({ error: "Server error" });
     }
};
// showing the changes made in the user dashboard route
export const saveChangedSession = async (req, res) => {
     try {
          const { id, startingContent, finalChanges, optimizedResume } = req.body;

          if (!id || !startingContent) {
               return res.status(400).json({ error: "Job ID and starting content are required" });
          }

          console.log('saveChangedSession - Received ID:', id);

          // Find the job first to get userID
          let job = null;
          try {
               job = await JobModel.findOne({ _id: id });
          } catch (error) {
               // Try with jobID if _id fails
          }
          
          if (!job) {
               job = await JobModel.findOne({ jobID: id });
          }

          if (!job) {
               console.log('saveChangedSession - Job not found for ID:', id);
               return res.status(404).json({ error: "Job not found" });
          }

          // Find the job and update it with the new changes
          const changesMade = {
               startingContent,
               finalChanges,
               timestamp: new Date().toLocaleString("en-US", "Asia/Kolkata"),
               changedSections: Object.keys(startingContent)
          };

          // Prepare update object
          const updateData = {
               changesMade,
               updatedAt: new Date().toLocaleString("en-US", "Asia/Kolkata")
          };

          // Add optimized resume data if provided
          if (optimizedResume && optimizedResume.resumeData) {
               console.log('saveChangedSession - Uploading resume data to R2...');
               
               // Upload resume data to R2
               const r2Result = await uploadJSONToR2(optimizedResume.resumeData, {
                    clientName: job.userID, // Use userID (email) as client name
                    jobID: job.jobID || id, // Use jobID for unique identification
                    folder: 'flashfirejobs'
               });

               if (r2Result.success) {
                    console.log('saveChangedSession - Resume data uploaded to R2 successfully:', r2Result.key);
                    
                    // Store only metadata and R2 key in MongoDB (NO resumeData field)
                    updateData.optimizedResume = {
                         resumeDataKey: r2Result.key, // Store R2 key
                         hasResume: true,
                         showSummary: optimizedResume.showSummary ?? true,
                         showProjects: optimizedResume.showProjects ?? false,
                         showLeadership: optimizedResume.showLeadership ?? true,
                         showPublications: optimizedResume.showPublications ?? false,
                         showTherapeuticAreas: optimizedResume.showTherapeuticAreas ?? false,
                         version: (job.optimizedResume?.version || 0) + 1, // Increment version
                         // Renamed headings travel with the resume, or the job
                         // card falls back to "LEADERSHIP & VOLUNTEERING".
                         sectionTitles: sectionTitlesFrom(optimizedResume),
                         createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                         sectionOrder: optimizedResume.sectionOrder || [
                              "personalInfo",
                              "summary",
                              "workExperience",
                              "projects",
                              "leadership",
                              "skills",
                              "education",
                              "publications",
                              "therapeuticAreas"
                         ],
                         storageType: 'r2' // Mark as R2 storage
                    };
                    console.log('saveChangedSession - Storing R2 key and metadata in MongoDB');
               } else {
                    console.error('saveChangedSession - Failed to upload to R2:', r2Result.error);
                    // If R2 fails, return error (don't save incomplete data)
                    return res.status(500).json({ 
                         error: "Failed to save resume data to storage",
                         details: r2Result.error
                    });
               }
          }

          // Update the job
          const updatedJob = await JobModel.findOneAndUpdate(
               { _id: job._id },
               updateData,
               { new: true }
          );

          console.log('saveChangedSession - Changes saved successfully for job:', updatedJob.jobTitle);

          // A hand-saved optimized resume gets its cover letter (re)written for
          // Executive clients with a base letter. Never throws.
          if (updateData.optimizedResume?.hasResume) {
               await enqueueCoverLetterIfEligible(job, { reason: 'optimized resume saved by hand' });
          }
          return res.json({ 
               message: "Changes saved successfully", 
               changesMade,
               jobId: id,
               storageType: updateData.optimizedResume?.storageType || 'none'
          });
     } catch (error) {
          console.error("Error saving changed session:", error);
          return res.status(500).json({ error: "Server error" });
     }
};

// Get optimized resume data by job ID
export const getOptimizedResume = async (req, res) => {
     try {
          const { jobId } = req.params;

          if (!jobId) {
               return res.status(400).json({ error: "Job ID is required" });
          }

          console.log('getOptimizedResume - Fetching resume for job ID:', jobId);

          let job = null;
          
          // First try to find by jobID field (string)
          try {
               job = await JobModel.findOne({ jobID: jobId }).select('optimizedResume');
               if (job) {
                    console.log('getOptimizedResume - Found job by jobID field');
               }
          } catch (error) {
               console.log('getOptimizedResume - Error searching by jobID:', error.message);
          }
          
          // If not found by jobID, try by _id (ObjectId) only if it looks like a valid ObjectId
          if (!job && jobId.length === 24 && /^[0-9a-fA-F]{24}$/.test(jobId)) {
               try {
                    job = await JobModel.findOne({ _id: jobId }).select('optimizedResume');
                    if (job) {
                         console.log('getOptimizedResume - Found job by _id field');
                    }
               } catch (error) {
                    console.log('getOptimizedResume - Error searching by _id:', error.message);
               }
          }

          if (!job) {
               console.log('getOptimizedResume - Job not found for ID:', jobId);
               return res.status(404).json({ error: "Job not found" });
          }

          if (!job.optimizedResume || !job.optimizedResume.hasResume) {
               console.log('getOptimizedResume - No optimized resume found for job:', jobId);
               return res.status(404).json({ error: "No optimized resume found for this job" });
          }

          // Check storage type and retrieve accordingly
          const storageType = job.optimizedResume.storageType || 'legacy';
          let resumeData = null;
          
          // TEMPORARY: Return debug info to see what's stored
          if (req.query.debug === 'true') {
               return res.json({
                    success: true,
                    debug: {
                         jobId: jobId,
                         storageType: storageType,
                         resumeDataR2Key: job.optimizedResume.resumeDataR2Key,
                         resumeDataKey: job.optimizedResume.resumeDataKey,
                         resumeDataUrl: job.optimizedResume.resumeDataUrl,
                         hasResume: job.optimizedResume.hasResume
                    },
                    extractedKeys: {
                         fromR2Key: job.optimizedResume.resumeDataR2Key ? extractR2Key(job.optimizedResume.resumeDataR2Key) : null,
                         fromDataKey: job.optimizedResume.resumeDataKey ? extractR2Key(job.optimizedResume.resumeDataKey) : null,
                         fromDataUrl: job.optimizedResume.resumeDataUrl ? extractR2Key(job.optimizedResume.resumeDataUrl) : null,
                    }
               });
          }

          if (storageType === 'r2') {
               // Prefer resumeDataR2Key if available (the actual key), otherwise extract from resumeDataKey
               console.log('getOptimizedResume - R2 storage detected. Checking keys:', {
                    resumeDataR2Key: job.optimizedResume.resumeDataR2Key,
                    resumeDataKey: job.optimizedResume.resumeDataKey,
                    resumeDataUrl: job.optimizedResume.resumeDataUrl
               });
               
               // If a public URL is present, fetch it directly
               const urlCandidate = job.optimizedResume.resumeDataKey && isR2Url(job.optimizedResume.resumeDataKey)
                    ? job.optimizedResume.resumeDataKey
                    : (job.optimizedResume.resumeDataUrl && isR2Url(job.optimizedResume.resumeDataUrl) 
                        ? job.optimizedResume.resumeDataUrl 
                        : null);
               if (urlCandidate) {
                    try {
                         console.log('getOptimizedResume - Fetching resume JSON via URL:', urlCandidate);
                         const resp = await fetch(urlCandidate);
                         if (!resp.ok) {
                              throw new Error(`HTTP ${resp.status} fetching ${urlCandidate}`);
                         }
                         resumeData = await resp.json();
                         return res.status(200).json({
                              success: true,
                              optimizedResume: {
                                   ...job.optimizedResume.toObject(),
                                   resumeData,
                                   storageType
                              }
                         });
                    } catch (err) {
                         console.error('getOptimizedResume - URL fetch failed, will try R2 key. Error:', err?.message || err);
                    }
               }

               // Try all possible keys in order of preference
               let r2Key = null;
               
               // 1. Direct R2 key (best option)
               if (job.optimizedResume.resumeDataR2Key) {
                    r2Key = job.optimizedResume.resumeDataR2Key.replace(/^\/+/, '').replace(/^test\//, '');
                    console.log('getOptimizedResume - Using resumeDataR2Key:', r2Key);
               }
               // 2. Extract from resumeDataKey
               else if (job.optimizedResume.resumeDataKey) {
                    r2Key = extractR2Key(job.optimizedResume.resumeDataKey);
                    console.log('getOptimizedResume - Extracted from resumeDataKey:', r2Key);
               }
               // 3. Extract from resumeDataUrl
               else if (job.optimizedResume.resumeDataUrl) {
                    r2Key = extractR2Key(job.optimizedResume.resumeDataUrl);
                    console.log('getOptimizedResume - Extracted from resumeDataUrl:', r2Key);
               }
               
               if (!r2Key) {
                    console.error('getOptimizedResume - No valid R2 key found for job:', jobId);
                    // Return debug info in development
                    if (process.env.NODE_ENV !== 'production') {
                         return res.status(500).json({ 
                              error: "Failed to retrieve resume data from storage",
                              details: "No valid R2 key found",
                              debug: {
                                   resumeDataR2Key: job.optimizedResume.resumeDataR2Key,
                                   resumeDataKey: job.optimizedResume.resumeDataKey,
                                   resumeDataUrl: job.optimizedResume.resumeDataUrl,
                                   storageType: storageType
                              }
                         });
                    }
                    return res.status(500).json({ 
                         error: "Failed to retrieve resume data from storage",
                         details: "No valid R2 key found"
                    });
               }
               
               // Fetch from R2
               console.log('getOptimizedResume - Fetching resume data from R2 with key:', r2Key);
               const r2Result = await getJSONFromR2(r2Key);
               
               if (r2Result.success) {
                    resumeData = r2Result.data;
                    console.log('getOptimizedResume - Successfully retrieved resume data from R2');
               } else {
                    console.error('getOptimizedResume - Failed to fetch from R2:', r2Result.error);
                    console.error('getOptimizedResume - Attempted key:', r2Key);
                    // Try alternative key formats if first attempt fails
                    const altKeys = [
                         r2Key.replace(/^Legacy\//, 'test/Legacy/'),
                         r2Key.replace(/^Legacy\//, 'flashfire-storage/Legacy/'),
                         `Legacy/${r2Key.split('/').slice(-2).join('/')}`, // Try just last two parts
                    ];
                    
                    for (const altKey of altKeys) {
                         console.log('getOptimizedResume - Trying alternative key:', altKey);
                         const altResult = await getJSONFromR2(altKey);
                         if (altResult.success) {
                              resumeData = altResult.data;
                              console.log('getOptimizedResume - Successfully retrieved with alternative key:', altKey);
                              break;
                         }
                    }
                    
                    if (!resumeData) {
                         // Always return debug info so we can see what's stored
                         return res.status(500).json({ 
                              error: "Failed to retrieve resume data from storage",
                              details: r2Result.error,
                              debug: {
                                   attemptedKey: r2Key,
                                   resumeDataR2Key: job.optimizedResume.resumeDataR2Key,
                                   resumeDataKey: job.optimizedResume.resumeDataKey,
                                   resumeDataUrl: job.optimizedResume.resumeDataUrl,
                                   alternativeKeysAttempted: altKeys,
                                   storageType: storageType
                              }
                         });
                    }
               }
          } else if (storageType === 'mongodb' || storageType === 'legacy') {
               // Use data from MongoDB (backward compatibility for old records)
               console.log('getOptimizedResume - Checking for legacy resume data in MongoDB');
               
               // Try to get resumeData if it exists (for old records before schema change)
               const fullJob = await JobModel.findOne({ _id: job._id }).lean();
               resumeData = fullJob?.optimizedResume?.resumeData;
               
               if (!resumeData) {
                    console.log('getOptimizedResume - No resume data found for legacy job:', jobId);
                    return res.status(404).json({ 
                         error: "No optimized resume data found for this job",
                         hint: "This job may need to be re-optimized to store data in R2"
                    });
               }
          }

          console.log('getOptimizedResume - Resume data found for job:', jobId);
          return res.status(200).json({
               success: true,
               optimizedResume: {
                    ...job.optimizedResume.toObject(),
                    resumeData: resumeData, // Include the actual resume data
                    storageType: storageType
               }
          });

     } catch (error) {
          console.error("Error fetching optimized resume:", error);
          return res.status(500).json({ error: "Server error" });
     }
};

// Get all jobs with optimized resumes for Documents section
export const getJobsWithOptimizedResumes = async (req, res) => {
     try {
          const userEmail = req.body?.email || req.body?.userDetails?.email || req.email;
          
          if (!userEmail) {
               return res.status(400).json({ error: "User email not found" });
          }

          console.log('getJobsWithOptimizedResumes - User email:', userEmail);

          // Find jobs that have optimized resumes
          const jobsWithResumes = await JobModel.find({ 
               userID: userEmail,
               'optimizedResume.hasResume': true 
          })
          .select('jobTitle companyName jobID joblink optimizedResume.hasResume optimizedResume.version optimizedResume.createdAt updatedAt createdAt')
          .lean();

          // Format the data for the Documents section
          const optimizedResumes = jobsWithResumes.map(job => ({
               id: job._id.toString(),
               jobID: job.jobID,
               title: `${job.jobTitle} at ${job.companyName}`,
               jobRole: job.jobTitle,
               companyName: job.companyName,
               jobLink: job.joblink || '#',
               createdAt: job.optimizedResume.createdAt || job.updatedAt || job.createdAt,
               category: 'Resume',
               version: job.optimizedResume.version,
               hasResume: job.optimizedResume.hasResume
          }));

          console.log(`getJobsWithOptimizedResumes - Found ${optimizedResumes.length} jobs with optimized resumes`);

          return res.status(200).json({
               success: true,
               optimizedResumes,
               count: optimizedResumes.length
          });

     } catch (error) {
          console.error("Error fetching jobs with optimized resumes:", error);
          return res.status(500).json({ error: "Server error" });
     }
};

// New endpoint specifically for Documents tab - gets all optimized resumes with full details
export const getOptimizedResumesForDocuments = async (req, res) => {
     try {
          const userEmail = req.body?.email || req.body?.userDetails?.email || req.email;
          
          if (!userEmail) {
               return res.status(400).json({ error: "User email not found" });
          }

          console.log('getOptimizedResumesForDocuments - User email:', userEmail);

          // Find jobs that have optimized resumes with full details
          const jobsWithResumes = await JobModel.find({ 
               userID: userEmail,
               'optimizedResume.hasResume': true 
          })
          .select('jobTitle companyName jobID joblink optimizedResume updatedAt createdAt')
          .sort({ 'optimizedResume.createdAt': -1, 'updatedAt': -1, 'createdAt': -1 }) // Sort by most recent first
          .lean();

          // Format the data for the Documents section with all details
          const optimizedResumes = await Promise.all(jobsWithResumes.map(async (job) => {
               // Handle date formatting - convert to ISO string if needed
               let createdAt = job.optimizedResume.createdAt || job.updatedAt || job.createdAt;
               
               // If createdAt is a string in DD/MM/YYYY format, convert it to ISO
               if (typeof createdAt === 'string' && createdAt.includes('/')) {
                    try {
                         // Parse DD/MM/YYYY, HH:MM:SS am/pm format
                         const parts = createdAt.split(', ');
                         if (parts.length === 2) {
                              const datePart = parts[0]; // "25/10/2025"
                              const timePart = parts[1]; // "1:46:11 pm"
                              
                              const [day, month, year] = datePart.split('/');
                              const [time, ampm] = timePart.split(' ');
                              const [hours, minutes, seconds] = time.split(':');
                              
                              let hour24 = parseInt(hours);
                              if (ampm.toLowerCase() === 'pm' && hour24 !== 12) {
                                   hour24 += 12;
                              } else if (ampm.toLowerCase() === 'am' && hour24 === 12) {
                                   hour24 = 0;
                              }
                              
                              const isoDate = new Date(year, month - 1, day, hour24, minutes, seconds).toISOString();
                              createdAt = isoDate;
                         }
                    } catch (error) {
                         console.error('Error parsing date:', createdAt, error);
                         // Fallback to current date
                         createdAt = new Date().toISOString();
                    }
               }

               // Fetch resume data from R2 if needed
               let resumeData = null;
               const storageType = job.optimizedResume.storageType || 'legacy';
               
               if (storageType === 'r2') {
                    // Prefer resumeDataR2Key if available, otherwise extract from resumeDataKey/URL
                    console.log('getOptimizedResumesForDocuments - R2 storage for job:', job.jobID, {
                         resumeDataR2Key: job.optimizedResume.resumeDataR2Key,
                         resumeDataKey: job.optimizedResume.resumeDataKey,
                         resumeDataUrl: job.optimizedResume.resumeDataUrl
                    });
                    // If URL present, fetch directly
                    const urlCandidate = job.optimizedResume.resumeDataKey && isR2Url(job.optimizedResume.resumeDataKey)
                         ? job.optimizedResume.resumeDataKey
                         : (job.optimizedResume.resumeDataUrl && isR2Url(job.optimizedResume.resumeDataUrl)
                              ? job.optimizedResume.resumeDataUrl
                              : null);
                    if (urlCandidate) {
                         try {
                              console.log('getOptimizedResumesForDocuments - Fetching via URL for job:', job.jobID, urlCandidate);
                              const resp = await fetch(urlCandidate);
                              if (resp.ok) {
                                   resumeData = await resp.json();
                              }
                         } catch (e) {
                              console.error('getOptimizedResumesForDocuments - URL fetch failed for job:', job.jobID, e?.message || e);
                         }
                    }
                    
                    let r2Key = resumeData ? null : (job.optimizedResume.resumeDataR2Key 
                         || extractR2Key(job.optimizedResume.resumeDataKey)
                         || extractR2Key(job.optimizedResume.resumeDataUrl));
                    
                    if (!resumeData && r2Key) {
                         console.log('getOptimizedResumesForDocuments - Fetching resume data from R2 for job:', job.jobID, 'with key:', r2Key);
                         const r2Result = await getJSONFromR2(r2Key);
                         if (r2Result.success) {
                              resumeData = r2Result.data;
                         } else {
                              console.error('getOptimizedResumesForDocuments - Failed to fetch from R2 for job:', job.jobID, r2Result.error);
                              console.error('getOptimizedResumesForDocuments - Attempted key:', r2Key);
                         }
                    } else {
                         console.error('getOptimizedResumesForDocuments - No valid R2 key found for job:', job.jobID);
                    }
               } else {
                    // For legacy data, try to get it if it still exists (backward compatibility)
                    // Note: resumeData field is commented out in schema, so this is only for old records
                    console.log('getOptimizedResumesForDocuments - Checking for legacy data for job:', job.jobID);
                    resumeData = job.optimizedResume.resumeData || null;
               }
               
               return {
                    id: job._id.toString(),
                    jobID: job.jobID,
                    title: `${job.jobTitle} at ${job.companyName}`,
                    jobRole: job.jobTitle,
                    companyName: job.companyName,
                    jobLink: job.joblink || '#',
                    createdAt: createdAt,
                    category: 'Resume',
                    version: job.optimizedResume.version || 0,
                    hasResume: job.optimizedResume.hasResume,
                    isJobBased: true, // This is a job-based resume
                    resumeData: resumeData,
                    showSummary: job.optimizedResume.showSummary,
                    showProjects: job.optimizedResume.showProjects,
                    showLeadership: job.optimizedResume.showLeadership,
                    showPublications: job.optimizedResume.showPublications,
                    sectionTitles: job.optimizedResume.sectionTitles || {},
                    storageType: storageType,
                    sectionOrder: job.optimizedResume.sectionOrder || [
                         "personalInfo",
                         "summary", 
                         "workExperience",
                         "projects",
                         "leadership",
                         "skills",
                         "education",
                         "publications"
                    ]
               };
          }));

          console.log(`getOptimizedResumesForDocuments - Found ${optimizedResumes.length} jobs with optimized resumes`);

          return res.status(200).json({
               success: true,
               optimizedResumes,
               count: optimizedResumes.length
          });

     } catch (error) {
          console.error("Error fetching optimized resumes for documents:", error);
          return res.status(500).json({ error: "Server error" });
     }
};

// Get a single job by _id or jobID to refresh session storage
export const getJobById = async (req, res) => {
     try {
          const { id } = req.body; // expecting { "id": "..." }

          if (!id) {
               return res.status(400).json({ error: "Job ID is required" });
          }

          console.log('getJobById - Fetching job with ID:', id);

          // Try to find job by both _id and jobID
          let job;
          try {
               // First try with MongoDB _id
               job = await JobModel.findById(id);
          } catch (error) {
               console.log('getJobById - Trying with jobID field for ID:', id);
          }

          // If not found by _id, try with jobID
          if (!job) {
               job = await JobModel.findOne({ jobID: id });
          }

          if (!job) {
               console.log('getJobById - Job not found for ID:', id);
               return res.status(404).json({ error: "Job not found" });
          }

          console.log('getJobById - Job found:', job.jobTitle);

          // Return the job with all fields
          return res.json({ 
               success: true, 
               job: {
                    _id: job._id.toString(),
                    jobID: job.jobID,
                    dateAdded: job.dateAdded,
                    userID: job.userID,
                    jobTitle: job.jobTitle,
                    currentStatus: job.currentStatus,
                    jobDescription: job.jobDescription,
                    joblink: job.joblink,
                    companyName: job.companyName,
                    timeline: job.timeline,
                    createdAt: job.createdAt,
                    updatedAt: job.updatedAt,
                    attachments: job.attachments,
                    changesMade: job.changesMade,
                    operatorName: job.operatorName,
                    operatorEmail: job.operatorEmail,
                    appliedDate: job.appliedDate
               }
          });
     } catch (error) {
          console.error("Error fetching job by ID:", error);
          return res.status(500).json({ error: "Server error" });
     }
};
