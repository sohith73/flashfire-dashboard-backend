// Where a job card came from, as one short line for Discord alerts.
//
// The best evidence wins:
//   1. importSource: the site or API the job was pulled from ("adzuna-api",
//      "seek", ...). Set by the API importers, and by the jr-direct extension
//      once it sends the board it scraped.
//   2. Otherwise who added it: the client, the jr-direct extension (it sends
//      an AI decision and usually an operator code), or an operator by hand.
//
// aiDecision is a nested schema path, so Mongoose may store an object of nulls
// on every card. Only aiDecision.reason counts as evidence.

/** Fields a caller must load for jobSourceLabel to work. */
export const JOB_SOURCE_FIELDS = "importSource createdByRole operatorName operatorEmail addedBy extensionCode aiDecision.reason";

const SITE_LABELS = Object.freeze({
  "adzuna-api": "Adzuna API",
  "indeed-api": "Indeed API",
  "glassdoor-scrape": "Glassdoor",
  "hiringcafe-scrape": "hiring.cafe",
  jobright: "JobRight",
  indeed: "Indeed",
  reed: "Reed",
  flexa: "Flexa",
  hiringcafe: "hiring.cafe",
  seek: "Seek",
  jora: "Jora",
  careerone: "CareerOne",
  adzuna: "Adzuna",
  linkedin: "LinkedIn",
  glassdoor: "Glassdoor",
});

/** Sites the extension may report as importSource. Anything else is dropped. */
export const EXTENSION_SITES = Object.freeze(
  ["jobright", "indeed", "reed", "flexa", "hiringcafe", "seek", "jora", "careerone", "adzuna", "linkedin", "glassdoor"]
);

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

export function jobSourceLabel(job) {
  if (!job) return "Unknown";
  const site = clean(job.importSource).toLowerCase();
  const who = clean(job.addedBy || job.operatorName);
  const viaExtension = Boolean(job.extensionCode || clean(job.aiDecision?.reason));

  if (site) {
    const label = SITE_LABELS[site] || site;
    return who && who !== "operations" ? `${label} (added by ${who})` : label;
  }
  if (job.createdByRole === "user" || job.operatorEmail === "user@flashfirehq") return "Added by the client";
  if (viaExtension) return who ? `Extension, site not recorded (pushed by ${who})` : "Extension, site not recorded";
  if (who && who !== "operations") return `Added by ${who}`;
  return "Not recorded";
}
