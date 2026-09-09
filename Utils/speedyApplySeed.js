// speedyApplySeed.js — build a SpeedyApply autofill profile from the client's
// FlashFire dashboard profile (ProfileModel).
//
// Why this exists: the SpeedyApply extension only ever read the
// `speedyapplyprofiles` collection, which is empty for every client who has
// never hand-filled the extension's own form. So a client who had already given
// FlashFire their address, phone, visa status and degrees signed into the
// extension and was asked to type all of it again — and autofill left Address
// Line 1 and School blank on real applications because the extension genuinely
// had no value for them.
//
// getSpeedyApplyProfile now overlays this seed onto the stored extension
// profile, filling ONLY the keys the stored profile leaves empty. A client who
// has curated their extension profile is never overwritten; a client who has
// not gets a working profile on first sign-in.
//
// The dashboard profile is free text typed by the client, so every parser here
// is best-effort and fails to "" rather than to a wrong guess. An empty field is
// recoverable (the client fills it); a wrong one silently goes out on a real job
// application.

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

// ProfileModel.address is a single free-text textarea ("Address" on the
// dashboard /profile page). The extension needs street / city / state / zip /
// country separately because ATS forms ask for them separately.
//
// Strategy: strip the postal code and the country off the end (both are
// recognisable by shape/name), then read the remainder right-to-left as
// [... street] , city , state.
const COUNTRY_ALIASES = {
  "india": "India",
  "bharat": "India",
  "usa": "United States",
  "u.s.a": "United States",
  "u.s.a.": "United States",
  "us": "United States",
  "u.s.": "United States",
  "united states": "United States",
  "united states of america": "United States",
  "america": "United States",
  "canada": "Canada",
  "uk": "United Kingdom",
  "u.k.": "United Kingdom",
  "england": "United Kingdom",
  "united kingdom": "United Kingdom",
  "great britain": "United Kingdom",
  "australia": "Australia",
  "germany": "Germany",
  "ireland": "Ireland",
  "singapore": "Singapore",
  "netherlands": "Netherlands",
  "new zealand": "New Zealand",
  "uae": "United Arab Emirates",
  "united arab emirates": "United Arab Emirates",
};

// US ZIP (12345 / 12345-6789), India PIN (6 digits), Canada (A1A 1A1),
// UK (SW1A 1AA and friends).
const POSTAL_RE = /^(?:\d{5}(?:-\d{4})?|\d{6}|[A-Z]\d[A-Z]\s?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i;

export function parseAddress(raw) {
  const out = { street: "", city: "", state: "", zip: "", country: "", raw: "" };
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return out;
  out.raw = text;

  // Newlines were already collapsed; split on commas and vertical bars.
  let parts = text.split(/[,|]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return out;

  // Country — last part, matched against the alias table only. Anything else is
  // left alone rather than guessed at.
  const lastKey = parts[parts.length - 1].toLowerCase().replace(/\.$/, "");
  if (COUNTRY_ALIASES[lastKey]) {
    out.country = COUNTRY_ALIASES[lastKey];
    parts.pop();
  }

  // Postal code — either its own part, or trailing on the last part
  // ("Maharashtra 411001").
  for (let i = parts.length - 1; i >= 0 && !out.zip; i--) {
    if (POSTAL_RE.test(parts[i])) {
      out.zip = parts[i];
      parts.splice(i, 1);
      continue;
    }
    const m = parts[i].match(/^(.*?)[\s-]+([\dA-Z]{3,10})$/i);
    if (m && POSTAL_RE.test(m[2])) {
      out.zip = m[2];
      parts[i] = m[1].trim();
      if (!parts[i]) parts.splice(i, 1);
    }
  }

  if (parts.length >= 3) {
    out.state = parts.pop();
    out.city = parts.pop();
    out.street = parts.join(", ");
  } else if (parts.length === 2) {
    out.state = parts.pop();
    out.city = parts.pop();
  } else if (parts.length === 1) {
    // One token left. If it carries a house/flat number it reads as a street
    // line; otherwise treat it as the city.
    if (/\d/.test(parts[0])) out.street = parts[0];
    else out.city = parts[0];
  }

  return out;
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

// bachelorsUniDegree / mastersUniDegree are one free-text line each, labelled
// on the dashboard as "University • Degree • Duration". Clients separate the
// pieces with bullets, commas, pipes or dashes and put them in any order, so
// classify each piece by what it contains rather than by position.
const DEGREE_RE = /\b(b\.?\s?tech|b\.?\s?e\b|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|b\.?\s?b\.?\s?a|bachelor'?s?|undergrad\w*|m\.?\s?tech|m\.?\s?sc|m\.?\s?s\b|m\.?\s?com|m\.?\s?a\b|m\.?\s?b\.?\s?a|master'?s?|ph\.?\s?d|doctorate|diploma|associate'?s?)\b/i;
const SCHOOL_RE = /\b(university|universit[ée]|college|institute|institut|school|academy|polytechnic|iit|nit|iiit|bits|vit|srm)\b/i;
const DURATION_RE = /^\D{0,12}(19|20)\d{2}\s*[-–—to]+\s*((19|20)\d{2}|present|current)\D{0,12}$/i;

// "B.Tech in Computer Science" → { degree: "B.Tech", field: "Computer Science" }
// "MS Data Science"            → { degree: "MS",     field: "Data Science" }
function splitDegreeAndField(piece) {
  const s = String(piece || "").trim();
  if (!s) return { degree: "", field: "" };

  // An explicit separator is the most reliable split. " in " beats " of " so
  // "Bachelor of Science in Computer Science" keeps the whole degree name.
  let m = s.match(/^(.*?)\s+in\s+(.+)$/i) || s.match(/^(.*?)\s+(?:-|–|—|:)\s+(.+)$/);
  if (m && DEGREE_RE.test(m[1])) return { degree: m[1].trim(), field: m[2].trim() };

  // No separator: take the leading degree token, the remainder is the major.
  const d = s.match(DEGREE_RE);
  if (d && d.index === 0 && d[0].length < s.length) {
    const rest = s.slice(d[0].length).trim().replace(/^(?:of|in)\s+/i, "");
    if (rest) return { degree: d[0].trim(), field: rest };
  }

  return { degree: s, field: "" };
}

// Pull the 4-digit years out of a duration fragment ("2018 - 2022").
function yearsFromDuration(piece) {
  const years = String(piece || "").match(/(19|20)\d{2}/g) || [];
  return { startDate: years[0] || "", endDate: years[1] || "" };
}

// Normalise whatever the dashboard stored for a graduation date to a plain
// year, which is what every ATS education field actually wants.
// Accepts "2024-05", "05/2024", "May 2024", an ISO date string.
function toYear(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = s.match(/(19|20)\d{2}/);
  return m ? m[0] : "";
}

export function parseEducationLine(line, { gpa = "", startDate = "", endDate = "" } = {}) {
  const text = String(line || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const pieces = text.split(/[•|,;]|\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);

  const entry = { institution: "", degree: "", field: "", gpa: String(gpa || "").trim(), startDate: "", endDate: "", honors: "" };
  const leftovers = [];

  for (const piece of pieces) {
    if (!entry.startDate && !entry.endDate && DURATION_RE.test(piece)) {
      Object.assign(entry, yearsFromDuration(piece));
      continue;
    }

    // One piece carrying both signals ("MS Data Science from Northeastern
    // University") must be split before either half is claimed — otherwise the
    // school test matches first and the whole sentence lands in `institution`,
    // which then goes into an ATS school typeahead and matches nothing.
    if (SCHOOL_RE.test(piece) && DEGREE_RE.test(piece)) {
      const m = piece.match(/^(.*?)\s+(?:from|at)\s+(.+)$/i);
      if (m) {
        const [degreeSide, schoolSide] = SCHOOL_RE.test(m[2]) ? [m[1], m[2]] : [m[2], m[1]];
        if (!entry.institution && SCHOOL_RE.test(schoolSide)) entry.institution = schoolSide.trim();
        if (!entry.degree && DEGREE_RE.test(degreeSide)) {
          const split = splitDegreeAndField(degreeSide.trim());
          entry.degree = split.degree;
          if (split.field && !entry.field) entry.field = split.field;
        }
        continue;
      }
    }

    if (!entry.institution && SCHOOL_RE.test(piece)) {
      entry.institution = piece;
      continue;
    }
    if (!entry.degree && DEGREE_RE.test(piece)) {
      const { degree, field } = splitDegreeAndField(piece);
      entry.degree = degree;
      if (field) entry.field = field;
      continue;
    }
    leftovers.push(piece);
  }

  // A single unsplittable line ("BTech Computer Science from XYZ University
  // 2018-2022") — mine it in place rather than dropping everything.
  if (!entry.institution) {
    const m = text.match(/(?:from|at)\s+(.+?)(?:\s*[•|,;]|$)/i);
    if (m && SCHOOL_RE.test(m[1])) entry.institution = m[1].trim();
  }
  if (!entry.degree) {
    const m = text.match(DEGREE_RE);
    if (m) entry.degree = m[0].trim();
  }
  if (!entry.field && leftovers.length) {
    // A leftover piece that is neither school nor degree nor a date is almost
    // always the major.
    const candidate = leftovers.find((p) => !/^\W*(19|20)\d{2}/.test(p) && p.length <= 60);
    if (candidate) entry.field = candidate;
  }
  if (!entry.startDate) entry.startDate = toYear(startDate) || yearsFromDuration(text).startDate;
  if (!entry.endDate) entry.endDate = toYear(endDate) || yearsFromDuration(text).endDate;

  // Nothing usable was recognised — hand back the raw line as the institution
  // so at least the client can see and correct it in the extension form.
  if (!entry.institution && !entry.degree) entry.institution = text;

  return entry;
}

// ---------------------------------------------------------------------------
// Work authorisation
// ---------------------------------------------------------------------------

// visaStatus → the two questions every US application asks. These answers go
// out on real applications, so only the statuses whose answer is unambiguous
// are mapped; anything else is left blank for the client to set.
//
//   workAuthorized            = "Are you legally authorised to work in the US?"
//   requiresVisaSponsorship   = "Will you now or in the future require sponsorship?"
const VISA_ANSWERS = {
  "u.s. citizen": { workAuthorized: "Yes", requiresVisaSponsorship: "No" },
  "green card": { workAuthorized: "Yes", requiresVisaSponsorship: "No" },
  "permanent resident (pr)": { workAuthorized: "Yes", requiresVisaSponsorship: "No" },
  "canadian citizen": { workAuthorized: "Yes", requiresVisaSponsorship: "No" },
  "open work permit (owp)": { workAuthorized: "Yes", requiresVisaSponsorship: "No" },
  "post-graduation work permit (pgwp)": { workAuthorized: "Yes", requiresVisaSponsorship: "No" },
  // Authorised to work today, will need sponsorship to continue.
  "f1 opt": { workAuthorized: "Yes", requiresVisaSponsorship: "Yes" },
  "f1 stem opt": { workAuthorized: "Yes", requiresVisaSponsorship: "Yes" },
  cpt: { workAuthorized: "Yes", requiresVisaSponsorship: "Yes" },
  h1b: { workAuthorized: "Yes", requiresVisaSponsorship: "Yes" },
  "employer-specific (closed) work permit": { workAuthorized: "Yes", requiresVisaSponsorship: "Yes" },
  // Not work-authorised on the visa alone.
  f1: { workAuthorized: "No", requiresVisaSponsorship: "Yes" },
  "study permit": { workAuthorized: "No", requiresVisaSponsorship: "Yes" },
};

function normalizeYesNo(value, yesRe, noRe) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (noRe.test(s)) return "No";
  if (yesRe.test(s)) return "Yes";
  return "";
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function toIsoDate(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

// buildSeedProfile: dashboard profile (+ user row) → SpeedyApply profile shape.
// Keys the dashboard has nothing for are simply absent, never "".
export function buildSeedProfile(dash, user = null) {
  if (!dash || typeof dash !== "object") return null;
  const seed = {};
  const put = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && !value.trim()) return;
    if (Array.isArray(value) && !value.length) return;
    seed[key] = typeof value === "string" ? value.trim() : value;
  };

  // ---- identity + contact
  const nameParts = String(user?.name || "").trim().split(/\s+/).filter(Boolean);
  put("firstName", dash.firstName || nameParts[0]);
  put("lastName", dash.lastName || (nameParts.length > 1 ? nameParts[nameParts.length - 1] : ""));
  put("email", dash.contactEmail || dash.email || user?.email);
  put("phone", dash.contactNumber);
  put("dateOfBirth", toIsoDate(dash.dob));

  // ---- links
  put("linkedinUrl", dash.linkedinUrl);
  put("githubUrl", dash.githubUrl);
  put("portfolioUrl", dash.portfolioUrl);
  put("resumeUrl", dash.resumeUrl);
  put("referrerName", dash.referredBy);

  // ---- address
  const address = parseAddress(dash.address);
  if (address.raw) seed.address = address;

  // ---- education (most recent first: masters before bachelors)
  const education = [];
  const masters = parseEducationLine(dash.mastersUniDegree, {
    gpa: dash.mastersGPA,
    startDate: dash.mastersStartDate,
    endDate: dash.mastersEndDate || dash.mastersGradMonthYear,
  });
  if (masters) education.push(masters);
  const bachelors = parseEducationLine(dash.bachelorsUniDegree, {
    gpa: dash.bachelorsGPA,
    startDate: dash.bachelorsStartDate,
    endDate: dash.bachelorsEndDate || dash.bachelorsGradMonthYear,
  });
  if (bachelors) education.push(bachelors);
  put("education", education);

  // ---- work authorisation
  const visaKey = String(dash.visaStatus || "").toLowerCase().trim();
  const answers = VISA_ANSWERS[visaKey];
  if (answers) {
    put("workAuthorized", answers.workAuthorized);
    put("requiresVisaSponsorship", answers.requiresVisaSponsorship);
  }
  const visaNote = visaKey === "other" ? dash.otherVisaType : dash.visaStatus;
  put("workAuthorizationNote", visaNote);

  // ---- application defaults
  put("salaryExpectation", dash.expectedSalaryNarrative || dash.expectedSalaryRange);
  put("availabilityDate", dash.availabilityNote || dash.joinTime);
  if (typeof dash.yearsOfExperience === "number" && dash.yearsOfExperience >= 0) {
    put("yearsOfExperience", String(dash.yearsOfExperience));
  }
  put("veteranStatus", normalizeYesNo(dash.veteranStatus, /^yes|\bam a\b|protected veteran/i, /^no|not a/i) === "No" ? "Not a protected veteran" : "");
  const disability = normalizeYesNo(dash.disabilityStatus, /^yes|have a disab/i, /^no|do not|don'?t have/i);
  put("disabilityStatus", disability);

  return Object.keys(seed).length ? seed : null;
}

// mergeSeed: overlay `seed` onto the client's stored extension profile, filling
// only what the stored profile leaves empty. Returns { profile, seededFields }.
//
// "Empty" means missing, "", or an empty array/object — never a value the
// client actually chose. address is merged key by key so a client who typed a
// city but no street keeps their city and gains a street.
export function mergeSeed(stored, seed) {
  const seededFields = [];
  if (!seed) return { profile: stored || null, seededFields };

  const isEmpty = (v) =>
    v === undefined ||
    v === null ||
    (typeof v === "string" && !v.trim()) ||
    (Array.isArray(v) && !v.length) ||
    (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

  const profile = { ...(stored && typeof stored === "object" ? stored : {}) };

  for (const [key, value] of Object.entries(seed)) {
    if (key === "address") {
      const merged = { ...(profile.address && typeof profile.address === "object" ? profile.address : {}) };
      let touched = false;
      for (const [k, v] of Object.entries(value)) {
        if (isEmpty(merged[k]) && !isEmpty(v)) {
          merged[k] = v;
          touched = true;
        }
      }
      if (touched) {
        profile.address = merged;
        seededFields.push("address");
      }
      continue;
    }
    if (isEmpty(profile[key])) {
      profile[key] = value;
      seededFields.push(key);
    }
  }

  return { profile, seededFields };
}
