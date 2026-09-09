// // controllers/Add_Update_Profile.js (ESM)
// import { ProfileModel } from "../Schema_Models/ProfileModel.js"; // fix path

// const splitList = (val) =>
//   Array.isArray(val)
//     ? val
//     : String(val ?? "")
//         .split(/[;,]/)
//         .map((s) => s.trim())
//         .filter(Boolean);

// const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");
// // ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,


// // Accept structured object or single-line "Street, City, State ZIP"
// const parseAddress = (addr) => {
//   if (!addr) return undefined;
//   if (typeof addr === "object") return addr;

//   const parts = String(addr).split(",").map((s) => s.trim());
//   const [street = "", city = "", stateZip = ""] = parts;
//   const [state = "", ...zipParts] = stateZip.split(/\s+/);
//   const zip = zipParts.join(" ").trim();

//   const result = {};
//   if (street) result.street = street;
//   if (city) result.city = city;
//   if (state) result.state = state;
//   if (zip) result.zip = zip;
//   if (Object.keys(result).length === 0) return undefined;

//   result.country = "United States";
//   return result;
// };


// const toDate = (val) => {
//   if (!val) return undefined;
//   if (val instanceof Date) return val;
//   if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(val))) {
//     const [y, m, d] = String(val).split("-").map(Number);
//     return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
//   }
//   const dt = new Date(val);
//   return isNaN(dt) ? undefined : dt;
// };

// export default async function Add_Update_Profile(req, res) {
//   try {
//     const b = req.body || {};
//     const email = b.email || b.userDetails?.email;
//     if (!email || !b.userDetails?.email || email !== b.userDetails.email) {
//       return res.status(403).json({ message: "Token or user details missing" });
//     }

//     // Build updates in schema types
//     const updates = {
//       email,
//       firstName: b.firstName,
//       lastName: b.lastName,
//       contactNumber: b.contactNumber,
//       dob: toDate(b.dob),

//       bachelorsUniDegree: b.bachelorsUniDegree,
//       bachelorsGradMonthYear: toDate(b.bachelorsGradMonthYear),
//       mastersUniDegree: b.mastersUniDegree,
//       mastersGradMonthYear: toDate(b.mastersGradMonthYear),

//       visaStatus: b.visaStatus,
//       visaExpiry: toDate(b.visaExpiry),

//       address: b.address || undefined,


//       preferredRoles: splitList(b.preferredRoles),
//       experienceLevel: b.experienceLevel,
//       expectedSalaryRange: b.expectedSalaryRange,

//       expectedSalaryNarrative: (b.expectedSalaryNarrative || "").trim() || undefined,

//       preferredLocations: splitList(b.preferredLocations),
//       targetCompanies: splitList(b.targetCompanies),
//       reasonForLeaving: b.reasonForLeaving,

//       linkedinUrl: b.linkedinUrl,
//       githubUrl: b.githubUrl,
//       portfolioUrl: b.portfolioUrl,
//       coverLetterUrl: b.coverLetterUrl,
//       resumeUrl: b.resumeUrl,

//       confirmAccuracy: b.confirmAccuracy,
//       agreeTos: b.agreeTos,

//       status: b.status || undefined,
//       // NEW FIELDS
//       // Free-text salary sentence the user typed
//       // expectedSalaryNarrative: (b.expectedSalaryNarrative ?? "").trim() || undefined,
//       // Availability / joining time sentence
//       availabilityNote: (b.availabilityNote ?? "").trim() || undefined,
//       // SSN (stored, not returned by default because schema has select:false)
//       ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,
//     };

//     // Clean undefineds and prevent bad embedded casts
//     for (const k of Object.keys(updates)) {
//       const v = updates[k];
//       if (v === undefined) delete updates[k];
//       if (k === "address" && (v === "" || v === null)) delete updates[k];
//     }
//     // Never persist auth stuff
//     delete updates.token;
//     delete updates.userDetails;

//     const updated = await ProfileModel.findOneAndUpdate(
//       { email },
//       { $set: updates },
//       { new: true, runValidators: true }
//     );

//     return res.json({
//       message: req.profileWasCreated
//         ? "Profile created successfully"
//         : "Profile updated successfully",
//       profile: updated,
//     });
//   } catch (err) {
//     console.error("Add_Update_Profile error:", err);
//     return res.status(500).json({ message: "Failed to set profile" });
//   }
// }


// // controllers/Add_Update_Profile.js (ESM)
// import { ProfileModel } from "../Schema_Models/ProfileModel.js"; // fix path

// const splitList = (val) =>
//   Array.isArray(val)
//     ? val
//     : String(val ?? "")
//         .split(/[;,]/)
//         .map((s) => s.trim())
//         .filter(Boolean);

// const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");
// // ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,


// // Accept structured object or single-line "Street, City, State ZIP"
// const parseAddress = (addr) => {
//   if (!addr) return undefined;
//   if (typeof addr === "object") return addr;

//   const parts = String(addr).split(",").map((s) => s.trim());
//   const [street = "", city = "", stateZip = ""] = parts;
//   const [state = "", ...zipParts] = stateZip.split(/\s+/);
//   const zip = zipParts.join(" ").trim();

//   const result = {};
//   if (street) result.street = street;
//   if (city) result.city = city;
//   if (state) result.state = state;
//   if (zip) result.zip = zip;
//   if (Object.keys(result).length === 0) return undefined;

//   result.country = "United States";
//   return result;
// };


// const toDate = (val) => {
//   if (!val) return undefined;
//   if (val instanceof Date) return val;
//   if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(val))) {
//     const [y, m, d] = String(val).split("-").map(Number);
//     return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
//   }
//   const dt = new Date(val);
//   return isNaN(dt) ? undefined : dt;
// };

// export default async function Add_Update_Profile(req, res) {
//   try {
//     const b = req.body || {};
//     const email = b.email || b.userDetails?.email;
//     if (!email || !b.userDetails?.email || email !== b.userDetails.email) {
//       return res.status(403).json({ message: "Token or user details missing" });
//     }

//     // Build updates in schema types
//     const updates = {
//       email,
//       firstName: b.firstName,
//       lastName: b.lastName,
//       contactNumber: b.contactNumber,
//       dob: toDate(b.dob),

//       bachelorsUniDegree: b.bachelorsUniDegree,
//       bachelorsGradMonthYear: toDate(b.bachelorsGradMonthYear),
//       mastersUniDegree: b.mastersUniDegree,
//       mastersGradMonthYear: toDate(b.mastersGradMonthYear),

//       visaStatus: b.visaStatus,
//       visaExpiry: toDate(b.visaExpiry),

//       address: b.address || undefined,


//       preferredRoles: splitList(b.preferredRoles),
//       experienceLevel: b.experienceLevel,
//       expectedSalaryRange: b.expectedSalaryRange,

//       expectedSalaryNarrative: (b.expectedSalaryNarrative || "").trim() || undefined,

//       preferredLocations: splitList(b.preferredLocations),
//       targetCompanies: splitList(b.targetCompanies),
//       reasonForLeaving: b.reasonForLeaving,

//       linkedinUrl: b.linkedinUrl,
//       githubUrl: b.githubUrl,
//       portfolioUrl: b.portfolioUrl,
//       coverLetterUrl: b.coverLetterUrl,
//       resumeUrl: b.resumeUrl,

//       confirmAccuracy: b.confirmAccuracy,
//       agreeTos: b.agreeTos,

//       status: b.status || undefined,
//       // NEW FIELDS
//       // Free-text salary sentence the user typed
//       // expectedSalaryNarrative: (b.expectedSalaryNarrative ?? "").trim() || undefined,
//       // Availability / joining time sentence
//       availabilityNote: (b.availabilityNote ?? "").trim() || undefined,
//       // SSN (stored, not returned by default because schema has select:false)
//       ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,
//     };

//     // Clean undefineds and prevent bad embedded casts
//     for (const k of Object.keys(updates)) {
//       const v = updates[k];
//       if (v === undefined) delete updates[k];
//       if (k === "address" && (v === "" || v === null)) delete updates[k];
//     }
//     // Never persist auth stuff
//     delete updates.token;
//     delete updates.userDetails;

//     const updated = await ProfileModel.findOneAndUpdate(
//       { email },
//       { $set: updates },
//       { new: true, runValidators: true }
//     );

//     return res.json({
//       message: req.profileWasCreated
//         ? "Profile created successfully"
//         : "Profile updated successfully",
//       profile: updated,
//     });
//   } catch (err) {
//     console.error("Add_Update_Profile error:", err);
//     return res.status(500).json({ message: "Failed to set profile" });
//   }
// }


// import { ProfileModel } from "../Schema_Models/ProfileModel.js";
// import { UserModel } from "../Schema_Models/UserModel.js";

// export default async function Add_Update_Profile(req, res) {
//   try {
//     const {
//       email, // This will be the contact email from the form
//       firstName,
//       lastName,
//       contactNumber,
//       dob,
//       address,
//       visaStatus,
//       otherVisaType,
//       bachelorsUniDegree,
//       bachelorsGradMonthYear,
//       bachelorsGPA,
//       mastersUniDegree,
//       mastersGradMonthYear,
//       mastersGPA,
//       transcriptUrl,
//       gpa,
//       undergraduateTranscript,
//       preferredRoles,
//       experienceLevel,
//       expectedSalaryRange,
//       preferredLocations,
//       targetCompanies,
//       reasonForLeaving,
//       joinTime,
//       linkedinUrl,
//       githubUrl,
//       portfolioUrl,
//       resumeUrl, // Now expects Cloudinary URL
//       coverLetterUrl, // Now expects Cloudinary URL
//       portfolioFileUrl, // New portfolio file field
//       confirmAccuracy,
//       agreeTos,
//       references,
//       dashboardManager,
//       dashboardManagerContact,
//       token,
//       userDetails,
//     } = req.body;

//     // Use the authentication email (username) as the primary key
//     const authEmail = userDetails?.email;
//     if (!authEmail) {
//       return res.status(400).json({ message: "Authentication email is required" });
//     }

//     // Check if this is a dashboard manager only update
//     const isDashboardManagerOnlyUpdate = dashboardManager !== undefined || dashboardManagerContact !== undefined;
    
//     if (!email && !isDashboardManagerOnlyUpdate) {
//       return res.status(400).json({ message: "Contact email is required" });
//     }

//     // Check if profile exists using authentication email
//     let existingProfile = await ProfileModel.findOne({ email: authEmail });

//     // If no profile found with auth email, check if there's an old profile with contact email as primary
//     if (!existingProfile) {
//       existingProfile = await ProfileModel.findOne({ email: email });
//       if (existingProfile) {
//         // Found old profile - update it to use auth email as primary and move old email to contactEmail
//         console.log('Found old profile, updating to new structure');
//         const updateData = {
//           email: authEmail, // Change primary email to auth email
//           contactEmail: email, // Move old email to contact email
//           firstName: firstName || existingProfile.firstName,
//           lastName: lastName || existingProfile.lastName,
//           contactNumber: contactNumber || existingProfile.contactNumber,
//           dob: dob || existingProfile.dob,
//           address: address || existingProfile.address,
//           visaStatus: visaStatus || existingProfile.visaStatus,
//           otherVisaType: otherVisaType || existingProfile.otherVisaType,
//           bachelorsUniDegree: bachelorsUniDegree || existingProfile.bachelorsUniDegree,
//           bachelorsGradMonthYear: bachelorsGradMonthYear || existingProfile.bachelorsGradMonthYear,
//           bachelorsGPA: bachelorsGPA !== undefined ? bachelorsGPA : existingProfile.bachelorsGPA,
//           mastersUniDegree: mastersUniDegree || existingProfile.mastersUniDegree,
//           mastersGradMonthYear: mastersGradMonthYear || existingProfile.mastersGradMonthYear,
//           mastersGPA: mastersGPA !== undefined ? mastersGPA : existingProfile.mastersGPA,
//           transcriptUrl: transcriptUrl !== undefined ? transcriptUrl : existingProfile.transcriptUrl,
//           gpa: gpa !== undefined ? gpa : existingProfile.gpa,
//           undergraduateTranscript: undergraduateTranscript || existingProfile.undergraduateTranscript,
//           preferredRoles: preferredRoles || existingProfile.preferredRoles,
//           experienceLevel: experienceLevel || existingProfile.experienceLevel,
//           expectedSalaryRange: expectedSalaryRange || existingProfile.expectedSalaryRange,
//           preferredLocations: preferredLocations || existingProfile.preferredLocations,
//           targetCompanies: targetCompanies || existingProfile.targetCompanies,
//           reasonForLeaving: reasonForLeaving || existingProfile.reasonForLeaving,
//           joinTime: joinTime || existingProfile.joinTime,
//           linkedinUrl: linkedinUrl || existingProfile.linkedinUrl,
//           githubUrl: githubUrl || existingProfile.githubUrl,
//           portfolioUrl: portfolioUrl || existingProfile.portfolioUrl,
//           resumeUrl: resumeUrl || existingProfile.resumeUrl,
//           coverLetterUrl: coverLetterUrl || existingProfile.coverLetterUrl,
//           portfolioFileUrl: portfolioFileUrl || existingProfile.portfolioFileUrl,
//           confirmAccuracy: confirmAccuracy !== undefined ? confirmAccuracy : existingProfile.confirmAccuracy,
//           agreeTos: agreeTos !== undefined ? agreeTos : existingProfile.agreeTos,
//           references: references !== undefined ? references : existingProfile.references,
//           dashboardManager: dashboardManager !== undefined ? dashboardManager : existingProfile.dashboardManager,
//           dashboardManagerContact: dashboardManagerContact !== undefined ? dashboardManagerContact : existingProfile.dashboardManagerContact,
//         };

//         const updatedProfile = await ProfileModel.findOneAndUpdate(
//           { email: email }, // Find by old email
//           updateData,
//           { new: true }
//         );

//         // Clean up any duplicate profiles
//         await ProfileModel.deleteMany({ 
//           email: email, 
//           _id: { $ne: updatedProfile._id } 
//         });

//         return res.json({
//           message: "Profile updated successfully (migrated from old structure)",
//           userProfile: updatedProfile,
//         });
//       }
//     }

//     if (existingProfile) {
//       // Update existing profile
//       const updateData = {
//         contactEmail: email, // Update contact email from form
//         firstName: firstName || existingProfile.firstName,
//         lastName: lastName || existingProfile.lastName,
//         contactNumber: contactNumber || existingProfile.contactNumber,
//         dob: dob || existingProfile.dob,
//         address: address || existingProfile.address,
//         visaStatus: visaStatus || existingProfile.visaStatus,
//         otherVisaType: otherVisaType || existingProfile.otherVisaType,
//         bachelorsUniDegree: bachelorsUniDegree || existingProfile.bachelorsUniDegree,
//         bachelorsGradMonthYear: bachelorsGradMonthYear || existingProfile.bachelorsGradMonthYear,
//         bachelorsGPA: bachelorsGPA !== undefined ? bachelorsGPA : existingProfile.bachelorsGPA,
//         mastersUniDegree: mastersUniDegree || existingProfile.mastersUniDegree,
//         mastersGradMonthYear: mastersGradMonthYear || existingProfile.mastersGradMonthYear,
//         mastersGPA: mastersGPA !== undefined ? mastersGPA : existingProfile.mastersGPA,
//         transcriptUrl: transcriptUrl !== undefined ? transcriptUrl : existingProfile.transcriptUrl,
//         gpa: gpa !== undefined ? gpa : existingProfile.gpa,
//         undergraduateTranscript: undergraduateTranscript || existingProfile.undergraduateTranscript,
//         preferredRoles: preferredRoles || existingProfile.preferredRoles,
//         experienceLevel: experienceLevel || existingProfile.experienceLevel,
//         expectedSalaryRange: expectedSalaryRange || existingProfile.expectedSalaryRange,
//         preferredLocations: preferredLocations || existingProfile.preferredLocations,
//         targetCompanies: targetCompanies || existingProfile.targetCompanies,
//         reasonForLeaving: reasonForLeaving || existingProfile.reasonForLeaving,
//         joinTime: joinTime || existingProfile.joinTime,
//         linkedinUrl: linkedinUrl || existingProfile.linkedinUrl,
//         githubUrl: githubUrl || existingProfile.githubUrl,
//         portfolioUrl: portfolioUrl || existingProfile.portfolioUrl,
//         resumeUrl: resumeUrl || existingProfile.resumeUrl, // Cloudinary URL
//         coverLetterUrl: coverLetterUrl || existingProfile.coverLetterUrl, // Cloudinary URL
//         portfolioFileUrl: portfolioFileUrl || existingProfile.portfolioFileUrl, // New portfolio file
//         confirmAccuracy: confirmAccuracy !== undefined ? confirmAccuracy : existingProfile.confirmAccuracy,
//         agreeTos: agreeTos !== undefined ? agreeTos : existingProfile.agreeTos,
//         references: references !== undefined ? references : existingProfile.references,
//         dashboardManager: dashboardManager !== undefined ? dashboardManager : existingProfile.dashboardManager,
//         dashboardManagerContact: dashboardManagerContact !== undefined ? dashboardManagerContact : existingProfile.dashboardManagerContact,
//       };

//       const updatedProfile = await ProfileModel.findOneAndUpdate(
//         { email: authEmail },
//         updateData,
//         { new: true }
//       );

//       return res.json({
//         message: "Profile updated successfully",
//         userProfile: updatedProfile,
//       });
//     } else {
//       // Create new profile
//       const newProfile = new ProfileModel({
//         email: authEmail, // Use authentication email as primary key
//         contactEmail: email, // Store contact email as separate field
//         firstName: firstName || "",
//         lastName: lastName || "",
//         contactNumber: contactNumber || "",
//         dob: dob || "",
//         address: address || "",
//         visaStatus: visaStatus || "",
//         otherVisaType: otherVisaType || "",
//         bachelorsUniDegree: bachelorsUniDegree || "",
//         bachelorsGradMonthYear: bachelorsGradMonthYear || "",
//         bachelorsGPA: bachelorsGPA || "",
//         mastersUniDegree: mastersUniDegree || "",
//         mastersGradMonthYear: mastersGradMonthYear || "",
//         mastersGPA: mastersGPA || "",
//         transcriptUrl: transcriptUrl || "",
//         gpa: gpa || null,
//         undergraduateTranscript: undergraduateTranscript || null,
//         preferredRoles: preferredRoles || [],
//         experienceLevel: experienceLevel || "",
//         expectedSalaryRange: expectedSalaryRange || "",
//         preferredLocations: preferredLocations || [],
//         targetCompanies: targetCompanies || [],
//         reasonForLeaving: reasonForLeaving || "",
//         joinTime: joinTime || "in 1 week",
//         linkedinUrl: linkedinUrl || "",
//         githubUrl: githubUrl || "",
//         portfolioUrl: portfolioUrl || "",
//         resumeUrl: resumeUrl || "", // Cloudinary URL
//         coverLetterUrl: coverLetterUrl || "", // Cloudinary URL
//         portfolioFileUrl: portfolioFileUrl || "", // New portfolio file
//         confirmAccuracy: confirmAccuracy || false,
//         agreeTos: agreeTos || false,
//         references: references || "",
//         dashboardManager: dashboardManager || "",
//         dashboardManagerContact: dashboardManagerContact || "",
//       });

//       const savedProfile = await newProfile.save();

//       return res.json({
//         message: "Profile created successfully",
//         userProfile: savedProfile,
//       });
//     }
//   } catch (error) {
//     console.error("Profile creation/update error:", error);
//     return res.status(500).json({
//       message: "Internal server error",
//       error: error.message,
//     });
//   }
// }


// // controllers/Add_Update_Profile.js (ESM)
// import { ProfileModel } from "../Schema_Models/ProfileModel.js"; // fix path

// const splitList = (val) =>
//   Array.isArray(val)
//     ? val
//     : String(val ?? "")
//         .split(/[;,]/)
//         .map((s) => s.trim())
//         .filter(Boolean);

// const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");
// // ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,


// // Accept structured object or single-line "Street, City, State ZIP"
// const parseAddress = (addr) => {
//   if (!addr) return undefined;
//   if (typeof addr === "object") return addr;

//   const parts = String(addr).split(",").map((s) => s.trim());
//   const [street = "", city = "", stateZip = ""] = parts;
//   const [state = "", ...zipParts] = stateZip.split(/\s+/);
//   const zip = zipParts.join(" ").trim();

//   const result = {};
//   if (street) result.street = street;
//   if (city) result.city = city;
//   if (state) result.state = state;
//   if (zip) result.zip = zip;
//   if (Object.keys(result).length === 0) return undefined;

//   result.country = "United States";
//   return result;
// };


// const toDate = (val) => {
//   if (!val) return undefined;
//   if (val instanceof Date) return val;
//   if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(val))) {
//     const [y, m, d] = String(val).split("-").map(Number);
//     return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
//   }
//   const dt = new Date(val);
//   return isNaN(dt) ? undefined : dt;
// };

// export default async function Add_Update_Profile(req, res) {
//   try {
//     const b = req.body || {};
//     const email = b.email || b.userDetails?.email;
//     if (!email || !b.userDetails?.email || email !== b.userDetails.email) {
//       return res.status(403).json({ message: "Token or user details missing" });
//     }

//     // Build updates in schema types
//     const updates = {
//       email,
//       firstName: b.firstName,
//       lastName: b.lastName,
//       contactNumber: b.contactNumber,
//       dob: toDate(b.dob),

//       bachelorsUniDegree: b.bachelorsUniDegree,
//       bachelorsGradMonthYear: toDate(b.bachelorsGradMonthYear),
//       mastersUniDegree: b.mastersUniDegree,
//       mastersGradMonthYear: toDate(b.mastersGradMonthYear),

//       visaStatus: b.visaStatus,
//       visaExpiry: toDate(b.visaExpiry),

//       address: b.address || undefined,


//       preferredRoles: splitList(b.preferredRoles),
//       experienceLevel: b.experienceLevel,
//       expectedSalaryRange: b.expectedSalaryRange,

//       expectedSalaryNarrative: (b.expectedSalaryNarrative || "").trim() || undefined,

//       preferredLocations: splitList(b.preferredLocations),
//       targetCompanies: splitList(b.targetCompanies),
//       reasonForLeaving: b.reasonForLeaving,

//       linkedinUrl: b.linkedinUrl,
//       githubUrl: b.githubUrl,
//       portfolioUrl: b.portfolioUrl,
//       coverLetterUrl: b.coverLetterUrl,
//       resumeUrl: b.resumeUrl,

//       confirmAccuracy: b.confirmAccuracy,
//       agreeTos: b.agreeTos,

//       status: b.status || undefined,
//       // NEW FIELDS
//       // Free-text salary sentence the user typed
//       // expectedSalaryNarrative: (b.expectedSalaryNarrative ?? "").trim() || undefined,
//       // Availability / joining time sentence
//       availabilityNote: (b.availabilityNote ?? "").trim() || undefined,
//       // SSN (stored, not returned by default because schema has select:false)
//       ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,
//     };

//     // Clean undefineds and prevent bad embedded casts
//     for (const k of Object.keys(updates)) {
//       const v = updates[k];
//       if (v === undefined) delete updates[k];
//       if (k === "address" && (v === "" || v === null)) delete updates[k];
//     }
//     // Never persist auth stuff
//     delete updates.token;
//     delete updates.userDetails;

//     const updated = await ProfileModel.findOneAndUpdate(
//       { email },
//       { $set: updates },
//       { new: true, runValidators: true }
//     );

//     return res.json({
//       message: req.profileWasCreated
//         ? "Profile created successfully"
//         : "Profile updated successfully",
//       profile: updated,
//     });
//   } catch (err) {
//     console.error("Add_Update_Profile error:", err);
//     return res.status(500).json({ message: "Failed to set profile" });
//   }
// }


// // controllers/Add_Update_Profile.js (ESM)
// import { ProfileModel } from "../Schema_Models/ProfileModel.js"; // fix path

// const splitList = (val) =>
//   Array.isArray(val)
//     ? val
//     : String(val ?? "")
//         .split(/[;,]/)
//         .map((s) => s.trim())
//         .filter(Boolean);

// const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");
// // ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,


// // Accept structured object or single-line "Street, City, State ZIP"
// const parseAddress = (addr) => {
//   if (!addr) return undefined;
//   if (typeof addr === "object") return addr;

//   const parts = String(addr).split(",").map((s) => s.trim());
//   const [street = "", city = "", stateZip = ""] = parts;
//   const [state = "", ...zipParts] = stateZip.split(/\s+/);
//   const zip = zipParts.join(" ").trim();

//   const result = {};
//   if (street) result.street = street;
//   if (city) result.city = city;
//   if (state) result.state = state;
//   if (zip) result.zip = zip;
//   if (Object.keys(result).length === 0) return undefined;

//   result.country = "United States";
//   return result;
// };


// const toDate = (val) => {
//   if (!val) return undefined;
//   if (val instanceof Date) return val;
//   if (/^\d{4}-\d{2}(-\d{2})?$/.test(String(val))) {
//     const [y, m, d] = String(val).split("-").map(Number);
//     return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
//   }
//   const dt = new Date(val);
//   return isNaN(dt) ? undefined : dt;
// };

// export default async function Add_Update_Profile(req, res) {
//   try {
//     const b = req.body || {};
//     const email = b.email || b.userDetails?.email;
//     if (!email || !b.userDetails?.email || email !== b.userDetails.email) {
//       return res.status(403).json({ message: "Token or user details missing" });
//     }

//     // Build updates in schema types
//     const updates = {
//       email,
//       firstName: b.firstName,
//       lastName: b.lastName,
//       contactNumber: b.contactNumber,
//       dob: toDate(b.dob),

//       bachelorsUniDegree: b.bachelorsUniDegree,
//       bachelorsGradMonthYear: toDate(b.bachelorsGradMonthYear),
//       mastersUniDegree: b.mastersUniDegree,
//       mastersGradMonthYear: toDate(b.mastersGradMonthYear),

//       visaStatus: b.visaStatus,
//       visaExpiry: toDate(b.visaExpiry),

//       address: b.address || undefined,


//       preferredRoles: splitList(b.preferredRoles),
//       experienceLevel: b.experienceLevel,
//       expectedSalaryRange: b.expectedSalaryRange,

//       expectedSalaryNarrative: (b.expectedSalaryNarrative || "").trim() || undefined,

//       preferredLocations: splitList(b.preferredLocations),
//       targetCompanies: splitList(b.targetCompanies),
//       reasonForLeaving: b.reasonForLeaving,

//       linkedinUrl: b.linkedinUrl,
//       githubUrl: b.githubUrl,
//       portfolioUrl: b.portfolioUrl,
//       coverLetterUrl: b.coverLetterUrl,
//       resumeUrl: b.resumeUrl,

//       confirmAccuracy: b.confirmAccuracy,
//       agreeTos: b.agreeTos,

//       status: b.status || undefined,
//       // NEW FIELDS
//       // Free-text salary sentence the user typed
//       // expectedSalaryNarrative: (b.expectedSalaryNarrative ?? "").trim() || undefined,
//       // Availability / joining time sentence
//       availabilityNote: (b.availabilityNote ?? "").trim() || undefined,
//       // SSN (stored, not returned by default because schema has select:false)
//       ssnNumber: b.ssnNumber != null ? onlyDigits(b.ssnNumber) : undefined,
//     };

//     // Clean undefineds and prevent bad embedded casts
//     for (const k of Object.keys(updates)) {
//       const v = updates[k];
//       if (v === undefined) delete updates[k];
//       if (k === "address" && (v === "" || v === null)) delete updates[k];
//     }
//     // Never persist auth stuff
//     delete updates.token;
//     delete updates.userDetails;

//     const updated = await ProfileModel.findOneAndUpdate(
//       { email },
//       { $set: updates },
//       { new: true, runValidators: true }
//     );

//     return res.json({
//       message: req.profileWasCreated
//         ? "Profile created successfully"
//         : "Profile updated successfully",
//       profile: updated,
//     });
//   } catch (err) {
//     console.error("Add_Update_Profile error:", err);
//     return res.status(500).json({ message: "Failed to set profile" });
//   }
// }


import { ProfileModel } from "../Schema_Models/ProfileModel.js";
import { UserModel } from "../Schema_Models/UserModel.js";
import { buildSummaryForEmail } from "./BuildAiSummary.js";

// Fire-and-forget AI summary rebuild. Profile create/update should not block
// on OpenAI latency; the dashboard polls /summaries-overview so the new
// summary surfaces as soon as the build completes.
function triggerSummaryRebuild(email, reason) {
  if (!email) return;
  setImmediate(() => {
    buildSummaryForEmail(email, reason)
      .then((r) => {
        if (r?.success) {
          console.log(`[summary-rebuild:${reason}] ok email=${email} words=${r.wordCount} source=${r.source}`);
        } else if (r?.skipped) {
          console.log(`[summary-rebuild:${reason}] skipped email=${email} — a build is already running, profile left stale for the sweep`);
        } else {
          console.warn(`[summary-rebuild:${reason}] fail email=${email} err=${r?.error} msg=${r?.message}`);
        }
      })
      .catch((e) => console.error(`[summary-rebuild:${reason}] threw email=${email}`, e));
  });
}

// Allowed employment-type values. Anything outside this set is dropped on
// save so a typo in the UI can't poison ProfileModel.employmentTypes.
const EMPLOYMENT_TYPE_ENUM = ["Full-time", "Part-time", "Contract", "Internship"];

// normaliseEmploymentTypes: validate + dedupe + default. `input` is the
// raw req.body value (array, string, or undefined). `fallback` is the
// existing profile's value (or null for create). Returns a clean array.
//   - Array of valid strings → dedupe, return.
//   - Empty array OR undefined → use fallback OR ["Full-time"].
//   - Single string → wrap, validate.
function normaliseEmploymentTypes(input, fallback) {
    const DEFAULT = ["Full-time"];
    const raw = Array.isArray(input)
        ? input
        : (typeof input === "string" && input.trim() ? input.split(",") : null);
    if (raw === null || raw === undefined) {
        return Array.isArray(fallback) && fallback.length ? fallback : DEFAULT;
    }
    const cleaned = [...new Set(
        raw
            .map((v) => String(v || "").trim())
            .filter((v) => EMPLOYMENT_TYPE_ENUM.includes(v))
    )];
    if (cleaned.length === 0) {
        return Array.isArray(fallback) && fallback.length ? fallback : DEFAULT;
    }
    return cleaned;
}

export default async function Add_Update_Profile(req, res) {
  try {
    const {
      email, // This will be the contact email from the form
      firstName,
      lastName,
      contactNumber,
      dob,
      address,
      visaStatus,
      otherVisaType,
      bachelorsUniDegree,
      bachelorsStartDate,
      bachelorsGradMonthYear,
      bachelorsEndDate,
      bachelorsGPA,
      mastersUniDegree,
      mastersStartDate,
      mastersGradMonthYear,
      mastersEndDate,
      mastersGPA,
      transcriptUrl,
      gpa,
      undergraduateTranscript,
      preferredRoles,
      experienceLevel,
      yearsOfExperience,
      expectedSalaryRange,
      expectedSalaryNarrative,
      preferredLocations,
      targetCompanies,
      reasonForLeaving,
      availabilityNote,
      ssnNumber,
      employmentTypes,
      veteranStatus,
      disabilityStatus,
      scholarshipRequired,
      usWorkEligibility,
      joinTime,
      linkedinUrl,
      githubUrl,
      portfolioUrl,
      resumeUrl, // Now expects Cloudinary URL
      coverLetterUrl, // Now expects Cloudinary URL
      portfolioFileUrl, // New portfolio file field
      confirmAccuracy,
      agreeTos,
      references,
      dashboardManager,
      dashboardManagerContact,
      referredBy,
      token,
      userDetails,
      secretKey,
    } = req.body;


    const SECRET_KEY = "flashfire@2025";
    if (secretKey && secretKey !== SECRET_KEY) {
      return res.status(403).json({ 
        message: "Incorrect secret key. Changes not saved.",
        error: "INVALID_SECRET_KEY"
      });
    }
    // Use the authentication email (username) as the primary key
    const authEmail = userDetails?.email;
    if (!authEmail) {
      return res.status(400).json({ message: "Authentication email is required" });
    }

    // Check if this is a dashboard manager only update
    const isDashboardManagerOnlyUpdate = dashboardManager !== undefined || dashboardManagerContact !== undefined;
    
    if (!email && !isDashboardManagerOnlyUpdate) {
      return res.status(400).json({ message: "Contact email is required" });
    }

    // Check if profile exists using authentication email
    let existingProfile = await ProfileModel.findOne({ email: authEmail });

    // If no profile found with auth email, check if there's an old profile with contact email as primary
    if (!existingProfile) {
      existingProfile = await ProfileModel.findOne({ email: email });
      if (existingProfile) {
        // Found old profile - update it to use auth email as primary and move old email to contactEmail
        console.log('Found old profile, updating to new structure');
        const updateData = {
          email: authEmail, // Change primary email to auth email
          contactEmail: email, // Move old email to contact email
          firstName: firstName || existingProfile.firstName,
          lastName: lastName || existingProfile.lastName,
          contactNumber: contactNumber || existingProfile.contactNumber,
          dob: dob || existingProfile.dob,
          address: address || existingProfile.address,
          visaStatus: visaStatus || existingProfile.visaStatus,
          otherVisaType: otherVisaType || existingProfile.otherVisaType,
          bachelorsUniDegree: bachelorsUniDegree || existingProfile.bachelorsUniDegree,
          bachelorsStartDate: bachelorsStartDate !== undefined ? bachelorsStartDate : existingProfile.bachelorsStartDate,
          bachelorsGradMonthYear: bachelorsGradMonthYear || existingProfile.bachelorsGradMonthYear,
          bachelorsEndDate: bachelorsEndDate !== undefined ? bachelorsEndDate : existingProfile.bachelorsEndDate,
          bachelorsGPA: bachelorsGPA !== undefined ? bachelorsGPA : existingProfile.bachelorsGPA,
          mastersUniDegree: mastersUniDegree !== undefined ? mastersUniDegree : existingProfile.mastersUniDegree,
          mastersStartDate: mastersStartDate !== undefined ? mastersStartDate : existingProfile.mastersStartDate,
          mastersGradMonthYear: mastersGradMonthYear !== undefined ? mastersGradMonthYear : existingProfile.mastersGradMonthYear,
          mastersEndDate: mastersEndDate !== undefined ? mastersEndDate : existingProfile.mastersEndDate,
          mastersGPA: mastersGPA !== undefined ? mastersGPA : existingProfile.mastersGPA,
          transcriptUrl: transcriptUrl !== undefined ? transcriptUrl : existingProfile.transcriptUrl,
          gpa: gpa !== undefined ? gpa : existingProfile.gpa,
          undergraduateTranscript: undergraduateTranscript || existingProfile.undergraduateTranscript,
          preferredRoles: preferredRoles || existingProfile.preferredRoles,
          experienceLevel: experienceLevel || existingProfile.experienceLevel,
          yearsOfExperience: yearsOfExperience !== undefined && yearsOfExperience !== ""
            ? Number(yearsOfExperience)
            : existingProfile.yearsOfExperience,
          expectedSalaryRange: expectedSalaryRange || existingProfile.expectedSalaryRange,
          expectedSalaryNarrative: expectedSalaryNarrative !== undefined ? expectedSalaryNarrative : existingProfile.expectedSalaryNarrative,
          preferredLocations: preferredLocations || existingProfile.preferredLocations,
          targetCompanies: targetCompanies || existingProfile.targetCompanies,
          reasonForLeaving: reasonForLeaving || existingProfile.reasonForLeaving,
          availabilityNote: availabilityNote !== undefined ? availabilityNote : existingProfile.availabilityNote,
          ssn: ssnNumber !== undefined ? ssnNumber : existingProfile.ssn,
          // Employment types — array. Falls back to existing value OR
          // ["Full-time"] default if never set. Validated against allowed
          // enum before persist.
          employmentTypes: normaliseEmploymentTypes(employmentTypes, existingProfile.employmentTypes),
          veteranStatus: veteranStatus !== undefined ? veteranStatus : existingProfile.veteranStatus,
          disabilityStatus: disabilityStatus !== undefined ? disabilityStatus : existingProfile.disabilityStatus,
          scholarshipRequired: scholarshipRequired !== undefined ? scholarshipRequired : existingProfile.scholarshipRequired,
          usWorkEligibility: usWorkEligibility !== undefined ? usWorkEligibility : existingProfile.usWorkEligibility,
          joinTime: joinTime || existingProfile.joinTime,
          linkedinUrl: linkedinUrl || existingProfile.linkedinUrl,
          githubUrl: githubUrl || existingProfile.githubUrl,
          portfolioUrl: portfolioUrl || existingProfile.portfolioUrl,
          resumeUrl: resumeUrl || existingProfile.resumeUrl,
          coverLetterUrl: coverLetterUrl || existingProfile.coverLetterUrl,
          portfolioFileUrl: portfolioFileUrl || existingProfile.portfolioFileUrl,
          confirmAccuracy: confirmAccuracy !== undefined ? confirmAccuracy : existingProfile.confirmAccuracy,
          agreeTos: agreeTos !== undefined ? agreeTos : existingProfile.agreeTos,
          references: references !== undefined ? references : existingProfile.references,
          dashboardManager: dashboardManager !== undefined ? dashboardManager : existingProfile.dashboardManager,
          dashboardManagerContact: dashboardManagerContact !== undefined ? dashboardManagerContact : existingProfile.dashboardManagerContact,
          referredBy: referredBy !== undefined ? referredBy : existingProfile.referredBy,
          // Profile changed → flag summary as stale so admin sees the rebuild banner.
          summaryStale: true,
        };

        const updatedProfile = await ProfileModel.findOneAndUpdate(
          { email: email }, // Find by old email
          updateData,
          { new: true }
        );

        // Clean up any duplicate profiles
        await ProfileModel.deleteMany({ 
          email: email, 
          _id: { $ne: updatedProfile._id } 
        });

        triggerSummaryRebuild(authEmail, "profile-migrate");
        return res.json({
          message: "Profile updated successfully (migrated from old structure)",
          userProfile: updatedProfile,
        });
      }
    }

    if (existingProfile) {
      // Update existing profile
      const updateData = {
        contactEmail: email, // Update contact email from form
        firstName: firstName || existingProfile.firstName,
        lastName: lastName || existingProfile.lastName,
        contactNumber: contactNumber || existingProfile.contactNumber,
        dob: dob || existingProfile.dob,
        address: address || existingProfile.address,
        visaStatus: visaStatus || existingProfile.visaStatus,
        otherVisaType: otherVisaType || existingProfile.otherVisaType,
        bachelorsUniDegree: bachelorsUniDegree || existingProfile.bachelorsUniDegree,
        bachelorsStartDate: bachelorsStartDate !== undefined ? bachelorsStartDate : existingProfile.bachelorsStartDate,
        bachelorsGradMonthYear: bachelorsGradMonthYear || existingProfile.bachelorsGradMonthYear,
        bachelorsEndDate: bachelorsEndDate !== undefined ? bachelorsEndDate : existingProfile.bachelorsEndDate,
        bachelorsGPA: bachelorsGPA !== undefined ? bachelorsGPA : existingProfile.bachelorsGPA,
        mastersUniDegree: mastersUniDegree !== undefined ? mastersUniDegree : existingProfile.mastersUniDegree,
        mastersStartDate: mastersStartDate !== undefined ? mastersStartDate : existingProfile.mastersStartDate,
        mastersGradMonthYear: mastersGradMonthYear !== undefined ? mastersGradMonthYear : existingProfile.mastersGradMonthYear,
        mastersEndDate: mastersEndDate !== undefined ? mastersEndDate : existingProfile.mastersEndDate,
        mastersGPA: mastersGPA !== undefined ? mastersGPA : existingProfile.mastersGPA,
        transcriptUrl: transcriptUrl !== undefined ? transcriptUrl : existingProfile.transcriptUrl,
        gpa: gpa !== undefined ? gpa : existingProfile.gpa,
        undergraduateTranscript: undergraduateTranscript || existingProfile.undergraduateTranscript,
        preferredRoles: preferredRoles || existingProfile.preferredRoles,
        experienceLevel: experienceLevel || existingProfile.experienceLevel,
        yearsOfExperience: yearsOfExperience !== undefined && yearsOfExperience !== ""
          ? Number(yearsOfExperience)
          : existingProfile.yearsOfExperience,
        expectedSalaryRange: expectedSalaryRange || existingProfile.expectedSalaryRange,
        expectedSalaryNarrative: expectedSalaryNarrative !== undefined ? expectedSalaryNarrative : existingProfile.expectedSalaryNarrative,
        preferredLocations: preferredLocations || existingProfile.preferredLocations,
        targetCompanies: targetCompanies || existingProfile.targetCompanies,
        reasonForLeaving: reasonForLeaving || existingProfile.reasonForLeaving,
        availabilityNote: availabilityNote !== undefined ? availabilityNote : existingProfile.availabilityNote,
        ssn: ssnNumber !== undefined ? ssnNumber : existingProfile.ssn,
        employmentTypes: normaliseEmploymentTypes(employmentTypes, existingProfile.employmentTypes),
        veteranStatus: veteranStatus !== undefined ? veteranStatus : existingProfile.veteranStatus,
        disabilityStatus: disabilityStatus !== undefined ? disabilityStatus : existingProfile.disabilityStatus,
        scholarshipRequired: scholarshipRequired !== undefined ? scholarshipRequired : existingProfile.scholarshipRequired,
        usWorkEligibility: usWorkEligibility !== undefined ? usWorkEligibility : existingProfile.usWorkEligibility,
        joinTime: joinTime || existingProfile.joinTime,
        linkedinUrl: linkedinUrl || existingProfile.linkedinUrl,
        githubUrl: githubUrl || existingProfile.githubUrl,
        portfolioUrl: portfolioUrl || existingProfile.portfolioUrl,
        resumeUrl: resumeUrl || existingProfile.resumeUrl, // Cloudinary URL
        coverLetterUrl: coverLetterUrl || existingProfile.coverLetterUrl, // Cloudinary URL
        portfolioFileUrl: portfolioFileUrl || existingProfile.portfolioFileUrl, // New portfolio file
        confirmAccuracy: confirmAccuracy !== undefined ? confirmAccuracy : existingProfile.confirmAccuracy,
        agreeTos: agreeTos !== undefined ? agreeTos : existingProfile.agreeTos,
        references: references !== undefined ? references : existingProfile.references,
        dashboardManager: dashboardManager !== undefined ? dashboardManager : existingProfile.dashboardManager,
        dashboardManagerContact: dashboardManagerContact !== undefined ? dashboardManagerContact : existingProfile.dashboardManagerContact,
        referredBy: referredBy !== undefined ? referredBy : existingProfile.referredBy,
        // Profile changed → flag summary as stale so admin sees the rebuild banner.
        summaryStale: true,
      };

      const updatedProfile = await ProfileModel.findOneAndUpdate(
        { email: authEmail },
        updateData,
        { new: true }
      );

      triggerSummaryRebuild(authEmail, "profile-update");
      return res.json({
        message: "Profile updated successfully",
        userProfile: updatedProfile,
      });
    } else {
      // Create new profile
      const newProfile = new ProfileModel({
        email: authEmail, // Use authentication email as primary key
        contactEmail: email, // Store contact email as separate field
        firstName: firstName || "",
        lastName: lastName || "",
        contactNumber: contactNumber || "",
        dob: dob || "",
        address: address || "",
        visaStatus: visaStatus || "",
        otherVisaType: otherVisaType || "",
        bachelorsUniDegree: bachelorsUniDegree || "",
        bachelorsStartDate: bachelorsStartDate || "",
        bachelorsGradMonthYear: bachelorsGradMonthYear || "",
        bachelorsEndDate: bachelorsEndDate || "",
        bachelorsGPA: bachelorsGPA || "",
        mastersUniDegree: mastersUniDegree || "",
        mastersStartDate: mastersStartDate || "",
        mastersGradMonthYear: mastersGradMonthYear || "",
        mastersEndDate: mastersEndDate || "",
        mastersGPA: mastersGPA || "",
        transcriptUrl: transcriptUrl || "",
        gpa: gpa || null,
        undergraduateTranscript: undergraduateTranscript || null,
        preferredRoles: preferredRoles || [],
        experienceLevel: experienceLevel || "",
        yearsOfExperience: yearsOfExperience !== undefined && yearsOfExperience !== "" ? Number(yearsOfExperience) : null,
        expectedSalaryRange: expectedSalaryRange || "",
        expectedSalaryNarrative: expectedSalaryNarrative || "",
        preferredLocations: preferredLocations || [],
        targetCompanies: targetCompanies || [],
        reasonForLeaving: reasonForLeaving || "",
        availabilityNote: availabilityNote || "",
        ssn: ssnNumber || "",
        employmentTypes: normaliseEmploymentTypes(employmentTypes, null),
        veteranStatus: veteranStatus || "",
        disabilityStatus: disabilityStatus || "",
        scholarshipRequired: scholarshipRequired || "",
        usWorkEligibility: usWorkEligibility || "",
        joinTime: joinTime || "in 1 week",
        linkedinUrl: linkedinUrl || "",
        githubUrl: githubUrl || "",
        portfolioUrl: portfolioUrl || "",
        resumeUrl: resumeUrl || "", // Cloudinary URL
        coverLetterUrl: coverLetterUrl || "", // Cloudinary URL
        portfolioFileUrl: portfolioFileUrl || "", // New portfolio file
        confirmAccuracy: confirmAccuracy || false,
        agreeTos: agreeTos || false,
        references: references || "",
        dashboardManager: dashboardManager || "",
        dashboardManagerContact: dashboardManagerContact || "",
        referredBy: referredBy || "",
      });

      const savedProfile = await newProfile.save();

      // First-time profile create: skip summary auto-build. Onboarding profile
      // is often skeletal (no resume linked yet, preferredRoles unparsed) so a
      // build here produces a brief the grader can't use. Summary will fire
      // on the next resume-link or profile-edit event.
      return res.json({
        message: "Profile created successfully",
        userProfile: savedProfile,
      });
    }
  } catch (error) {
    console.error("Profile creation/update error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
}







