// Which clients are looking for jobs in Europe, and what to search for them.
//
// The Flashfire Autopilot desktop app has a "Run Europe clients" button: one
// press, the operator clicks Allow in Chrome once, and every Europe client is
// searched on HiringCafe, Glassdoor and Indeed. A 3 AM weekday Discord reminder
// (Utils/europeRunReminder.js) tells the team to press it. Both read this list,
// so "who counts as Europe" has exactly one definition.
//
// A client is a Europe client only when Client Tracking has their country
// (dashboardtrackings.clientCountry) set to "Europe". "UK" is its own country
// there and is NOT part of the Europe run. The client's preferredLocations are
// used only to choose where to search (country codes, place names).
//
// Only active, unpaused clients (the operations status in dashboardtrackings)
// are returned, so a paused or churned client is never scraped by accident.

// name/alias -> ISO 3166-1 alpha-2. Glassdoor and Indeed take a country code.
export const EUROPE_COUNTRIES = {
  "united kingdom": "gb", uk: "gb", "great britain": "gb", britain: "gb", england: "gb",
  scotland: "gb", wales: "gb", "northern ireland": "gb",
  ireland: "ie", netherlands: "nl", "the netherlands": "nl", holland: "nl",
  germany: "de", deutschland: "de", france: "fr", belgium: "be", luxembourg: "lu",
  switzerland: "ch", austria: "at", spain: "es", portugal: "pt", italy: "it",
  sweden: "se", norway: "no", denmark: "dk", finland: "fi", iceland: "is",
  poland: "pl", "czech republic": "cz", czechia: "cz", slovakia: "sk", hungary: "hu",
  romania: "ro", bulgaria: "bg", greece: "gr", croatia: "hr", slovenia: "si",
  serbia: "rs", estonia: "ee", latvia: "lv", lithuania: "lt", malta: "mt", cyprus: "cy",
};

// Cities people write instead of the country. Kept to unambiguous names.
const EUROPE_CITIES = {
  london: "gb", manchester: "gb", birmingham: "gb", edinburgh: "gb", glasgow: "gb",
  leeds: "gb", bristol: "gb", cambridge: "gb", oxford: "gb", dublin: "ie",
  amsterdam: "nl", rotterdam: "nl", eindhoven: "nl", utrecht: "nl", "the hague": "nl",
  berlin: "de", munich: "de", frankfurt: "de", hamburg: "de", cologne: "de", stuttgart: "de",
  paris: "fr", lyon: "fr", brussels: "be", zurich: "ch", geneva: "ch", basel: "ch",
  vienna: "at", madrid: "es", barcelona: "es", lisbon: "pt", milan: "it", rome: "it",
  stockholm: "se", oslo: "no", copenhagen: "dk", helsinki: "fi", warsaw: "pl",
  prague: "cz", budapest: "hu", athens: "gr", maribor: "si", ljubljana: "si",
};

const EUROPE_WORDS = new Set(["europe", "eu", "european union", "emea", "eea", "schengen"]);

// Clear signs a client is looking OUTSIDE Europe. A European city name on its
// own is weak evidence: Cambridge, London, Dublin and Birmingham also exist in
// Canada and the US ("Greater Toronto Area, Toronto, Oakville, Cambridge" is
// Cambridge, Ontario). When any of these appears in a client's locations, bare
// city names stop counting; a European country or Europe/EU still does.
const NON_EUROPE_PHRASES = [
  // countries and regions
  "united states", "usa", "america", "canada", "india", "australia", "new zealand", "singapore",
  "uae", "united arab emirates", "dubai", "abu dhabi", "saudi", "qatar", "japan", "china", "hong kong",
  "mexico", "brazil", "south africa", "north america", "latam", "apac",
  // Canadian provinces and cities
  "ontario", "quebec", "british columbia", "alberta", "manitoba", "saskatchewan", "nova scotia",
  "new brunswick", "toronto", "gta", "mississauga", "oakville", "etobicoke", "brampton", "markham",
  "vancouver", "montreal", "calgary", "ottawa", "edmonton", "waterloo", "kitchener", "winnipeg",
  // US states
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky",
  "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico",
  "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania",
  "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  // big US metros people write instead of the state
  "nyc", "bay area", "san francisco", "san jose", "los angeles", "san diego", "seattle", "boston",
  "chicago", "austin", "dallas", "houston", "atlanta", "denver", "phoenix", "miami", "silicon valley",
  // Indian and Australian cities
  "bangalore", "bengaluru", "mumbai", "delhi", "hyderabad", "pune", "chennai", "gurgaon", "noida",
  "sydney", "melbourne", "brisbane", "perth",
];
const NON_EUROPE_RX = new RegExp(`\\b(${NON_EUROPE_PHRASES.join("|")})\\b`, "i");
// Two-letter US state / Canadian province codes, only as a whole token ("MA",
// "ON"). Codes that are also ordinary words (in, me, or, ok, hi, oh) are left out.
const NON_EUROPE_CODES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "fl", "ga", "ia", "id", "il", "ks", "ky", "la", "ma",
  "md", "mi", "mn", "mo", "ms", "mt", "nc", "nd", "ne", "nh", "nj", "nm", "nv", "ny", "pa", "ri",
  "sc", "sd", "tn", "tx", "ut", "va", "vt", "wa", "wi", "wv", "wy", "dc",
  "on", "qc", "bc", "ab", "mb", "sk", "ns", "nb",
]);

/** True when the locations clearly point somewhere outside Europe. */
export function hasNonEuropeSignal(preferredLocations) {
  return locationTokens(preferredLocations).some(
    (t) => NON_EUROPE_CODES.has(t) || (!EUROPE_COUNTRIES[t] && NON_EUROPE_RX.test(t))
  );
}

/** Split "EU/ Australia/Canada" or "London, UK; Berlin" into trimmed tokens. */
export function locationTokens(values) {
  const list = Array.isArray(values) ? values : [values];
  return list
    .flatMap((v) => String(v || "").split(/[,/;|\n]|\band\b|&/i))
    .map((t) => t.trim().toLowerCase().replace(/[().]/g, "").replace(/\s+/g, " "))
    .filter(Boolean);
}

/**
 * The European part of a client's preferred locations.
 * Returns { isEurope, countries: [iso2...] in profile order, places: [original strings] }.
 * `places` keeps the client's own wording (city + country) for HiringCafe,
 * which resolves locations itself; `countries` feeds Glassdoor and Indeed.
 */
export function europeanLocations(preferredLocations) {
  const countries = [];
  const places = [];
  let isEurope = false;
  // Bare city names only count when nothing points outside Europe.
  const citiesTrusted = !hasNonEuropeSignal(preferredLocations);
  for (const raw of Array.isArray(preferredLocations) ? preferredLocations : [preferredLocations]) {
    const tokens = locationTokens(raw);
    let rawIsEurope = false;
    for (const t of tokens) {
      const iso = EUROPE_COUNTRIES[t] || (citiesTrusted ? EUROPE_CITIES[t] : undefined);
      if (iso) {
        rawIsEurope = true;
        if (!countries.includes(iso)) countries.push(iso);
      } else if (EUROPE_WORDS.has(t)) {
        rawIsEurope = true;
      }
    }
    if (rawIsEurope) {
      isEurope = true;
      // Keep the concrete European parts only ("EU/ Australia/Canada" -> nothing
      // concrete; "Maribor, Slovenia" -> "Maribor, Slovenia").
      const concrete = tokens.filter((t) => EUROPE_COUNTRIES[t] || (citiesTrusted && EUROPE_CITIES[t]));
      if (concrete.length) places.push(String(raw).trim());
    }
  }
  return { isEurope, countries, places };
}

/** "Test Automation | Framework Design, QA" -> ["Test Automation", "Framework Design", "QA"]. */
export function roleTerms(preferredRoles, max = 8) {
  const out = [];
  for (const raw of Array.isArray(preferredRoles) ? preferredRoles : [preferredRoles]) {
    for (const part of String(raw || "").split(/[,|;/\n]/)) {
      const t = part.trim().replace(/\s+/g, " ");
      if (t && t.length <= 60 && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
    }
  }
  return out.slice(0, max);
}

// The boards the Europe run works through. A Europe client gets all three on
// its scrape-source allowlist (profile.scrapeSources), added to whatever is
// already there and never removing anything.
export const EUROPE_SOURCES = ["indeed", "glassdoor", "hiringcafe"];

/** The allowlist with the Europe boards added. No list saved means JobRight only. */
export function withEuropeSources(current) {
  const base = Array.isArray(current) && current.length
    ? [...new Set(current.map((s) => String(s || "").toLowerCase().trim()).filter(Boolean))]
    : ["jobright"];
  return [...base, ...EUROPE_SOURCES.filter((s) => !base.includes(s))];
}

/**
 * Every active, unpaused Europe client with what to search.
 * A client is a Europe client ONLY when Client Tracking has its country
 * (dashboardtrackings.clientCountry) set to "Europe". "UK" is a separate
 * country and is not included.
 * Models are passed in so the function can be tested without a database.
 */
export async function getEuropeClients({ ProfileModel, ClientPaymentLookup }) {
  const statuses = await ClientPaymentLookup.find({}).select("email name status isPaused clientCountry").lean();
  const byEmail = new Map(statuses.filter((s) => s.email).map((s) => [String(s.email).toLowerCase().trim(), s]));
  const markedEurope = [...byEmail].filter(([, s]) => s.clientCountry === "Europe").map(([e]) => e);
  if (!markedEurope.length) return [];
  const profiles = await ProfileModel.find(
    { email: { $in: markedEurope } },
    { email: 1, firstName: 1, lastName: 1, preferredLocations: 1, preferredRoles: 1, scrapeSources: 1 }
  ).lean();

  const out = [];
  for (const p of profiles) {
    const email = String(p.email || "").toLowerCase().trim();
    if (!email) continue;
    const st = byEmail.get(email);
    if (!st || String(st.status || "").toLowerCase() !== "active" || st.isPaused === true) continue;
    if (st.clientCountry !== "Europe") continue;
    // Locations only decide WHERE to search, never WHO is in the run.
    const loc = europeanLocations(p.preferredLocations || []);
    out.push({
      email,
      name: st.name || [p.firstName, p.lastName].filter(Boolean).join(" ") || email,
      roles: roleTerms(p.preferredRoles),
      places: loc.places,
      countries: loc.countries,
      country: loc.countries[0] || "",
      preferredLocations: p.preferredLocations || [],
      scrapeSources: Array.isArray(p.scrapeSources) ? p.scrapeSources : [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Turn Indeed, Glassdoor and HiringCafe on for these clients. One bulkWrite,
 * only for clients missing one of them. Returns how many profiles changed.
 */
export async function ensureEuropeSources({ ProfileModel, clients }) {
  const ops = [];
  for (const c of clients) {
    const next = withEuropeSources(c.scrapeSources);
    const had = Array.isArray(c.scrapeSources) ? c.scrapeSources : [];
    if (had.length && next.length === had.length) continue;
    ops.push({ updateOne: { filter: { email: c.email }, update: { $set: { scrapeSources: next } } } });
  }
  if (!ops.length) return 0;
  const r = await ProfileModel.bulkWrite(ops, { ordered: false });
  return r.modifiedCount ?? ops.length;
}
