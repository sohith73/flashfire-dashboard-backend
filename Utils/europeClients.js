// Which clients are looking for jobs in Europe, and what to search for them.
//
// The Flashfire Autopilot desktop app has a "Run Europe clients" button: one
// press, the operator clicks Allow in Chrome once, and every Europe client is
// searched on HiringCafe, Glassdoor and Indeed. A 3 AM weekday Discord reminder
// (Utils/europeRunReminder.js) tells the team to press it. Both read this list,
// so "who counts as Europe" has exactly one definition.
//
// A client is a Europe client when any of their dashboard preferredLocations
// names a European country, a well-known European city, or Europe/EU itself.
// The UK counts. Nothing is stored: a new client with "Netherlands" in their
// profile is on tomorrow's list automatically.
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
  for (const raw of Array.isArray(preferredLocations) ? preferredLocations : [preferredLocations]) {
    const tokens = locationTokens(raw);
    let rawIsEurope = false;
    for (const t of tokens) {
      const iso = EUROPE_COUNTRIES[t] || EUROPE_CITIES[t];
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
      const concrete = tokens.filter((t) => EUROPE_COUNTRIES[t] || EUROPE_CITIES[t]);
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

/**
 * Every active, unpaused Europe client with what to search.
 * Models are passed in so the function can be tested without a database.
 */
export async function getEuropeClients({ ProfileModel, ClientPaymentLookup }) {
  const [profiles, statuses] = await Promise.all([
    ProfileModel.find(
      { "preferredLocations.0": { $exists: true } },
      { email: 1, firstName: 1, lastName: 1, preferredLocations: 1, preferredRoles: 1 }
    ).lean(),
    ClientPaymentLookup.find({}).select("email name status isPaused").lean(),
  ]);
  const byEmail = new Map(statuses.filter((s) => s.email).map((s) => [String(s.email).toLowerCase().trim(), s]));

  const out = [];
  for (const p of profiles) {
    const email = String(p.email || "").toLowerCase().trim();
    if (!email) continue;
    const st = byEmail.get(email);
    if (!st || String(st.status || "").toLowerCase() !== "active" || st.isPaused === true) continue;
    const loc = europeanLocations(p.preferredLocations);
    if (!loc.isEurope) continue;
    out.push({
      email,
      name: st.name || [p.firstName, p.lastName].filter(Boolean).join(" ") || email,
      roles: roleTerms(p.preferredRoles),
      places: loc.places,
      countries: loc.countries,
      country: loc.countries[0] || "",
      preferredLocations: p.preferredLocations,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
