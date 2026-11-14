// Shared in-memory employer-name matcher for the sponsor lists that live in
// memory (Australia: auVisaSponsor.js, Europe: euVisaSponsor.js). Each
// country supplies its own vocabulary; the matching rules are the same:
//
//   1. exact key                    "Atlassian" = "ATLASSIAN PTY LTD"
//   2. a short alias table          "AWS" -> Amazon Web Services, before 3 so
//                                   it beats a look-alike prefix ("AWS Services Vic")
//   3. brand + generic words only   "Commonwealth Bank" -> "...Bank of Australia";
//                                   the job's own generic tail is trimmed too
//   4. spaces ignored               "Judo Bank" = OCR "JudoBankPtyLtd"
//
// A key is lowercase ASCII letters and digits, "&" read as "and", with the
// country's legal-form words ("Pty Ltd", "B.V.", "DAC") removed.

const MIN_PREFIX_LEN = 3;
// Ignoring spaces is a weaker signal than an exact key, so it needs a longer
// name: "a b c" joined to "abc" is a coincidence, "judo bank" -> "judobank" is not.
export const MIN_COMPACT_LEN = 6;

/**
 * @param {object} o
 * @param {Set<string>} o.legal     words that say nothing about WHICH employer it is
 * @param {Set<string>} o.generic   words a listed name may add after a brand
 * @param {Map<string,string[]>} [o.aliases]  job-board key -> listed keys to try
 * @param {RegExp} [o.prefixRx]     stripped from the start before keying ("The Trustee for")
 * @param {RegExp} [o.splitRx]      splits one name into several ("X ATF Y", "X T/A Y")
 * @param {RegExp} [o.leadingRx]    an optional leading word also tried without ("NSW ...")
 * @param {RegExp} [o.gluedLegalRx] a legal suffix glued on with no space ("judobankptyltd")
 * @param {(e:object)=>number} [o.weight]  which entry wins when two share a key
 */
export function createSponsorMatcher({
  legal, generic, aliases = new Map(), prefixRx = null, splitRx = null, leadingRx = null,
  gluedLegalRx = /(?:limited|ltd|incorporated)$/, weight = () => 0,
}) {
  function nameKey(raw) {
    let s = String(raw ?? "");
    if (prefixRx) s = s.replace(prefixRx, "");
    s = s.normalize("NFKD")
      .replace(/[^\x00-\x7f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/\+/g, " and ")
      .replace(/['’.]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!s) return "";
    const words = s.split(" ");
    const core = words.filter((w) => !legal.has(w));
    return (core.length ? core : words).join(" ").replace(/(?: and)+$/, "").trim();
  }

  /** Every key a name should be findable under: whole, each part of a split
   *  name, hyphens joined, and without a parenthetical ("Tyreda (Australia)"). */
  function nameKeys(raw) {
    let name = String(raw ?? "");
    if (prefixRx) name = name.replace(prefixRx, "");
    let parts = splitRx ? [name, ...name.split(splitRx)] : [name];
    if (leadingRx) parts = parts.flatMap((p) => [p, p.replace(leadingRx, "")]);
    const variants = parts.flatMap((p) => [p, p.replace(/-/g, ""), p.replace(/\([^)]*\)/g, " ")]);
    return [...new Set(variants.map(nameKey).filter(Boolean))];
  }

  /** Key without spaces and without a glued-on legal suffix. */
  function compactKey(key) {
    let c = String(key || "").replace(/ /g, "");
    for (let prev = ""; prev !== c && c.length > MIN_COMPACT_LEN;) {
      prev = c;
      const cut = c.replace(gluedLegalRx, "");
      if (cut.length >= MIN_COMPACT_LEN) c = cut;
    }
    return c.replace(/^the(?=.{6})/, "");
  }

  /** entries: objects with at least { name }. Several may share a name. */
  function buildIndex(entries) {
    const byKey = new Map();
    const byCompact = new Map();
    const put = (map, key, entry) => {
      const prev = map.get(key);
      if (!prev || weight(entry) > weight(prev)) map.set(key, entry);
    };
    for (const entry of entries) {
      for (const key of nameKeys(entry.name)) {
        put(byKey, key, entry);
        const compact = compactKey(key);
        if (compact.length >= MIN_COMPACT_LEN) put(byCompact, compact, entry);
      }
    }
    return { byKey, byCompact, sorted: [...byKey.keys()].sort() };
  }

  const allGeneric = (rest) => rest.split(" ").every((w) => generic.has(w));
  const best = (hits) => hits.reduce((a, b) => (weight(b) > weight(a) ? b : a));

  function* withPrefix(idx, prefix) {
    const keys = idx.sorted;
    let lo = 0, hi = keys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (keys[mid] < prefix) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i++) yield [keys[i], idx.byKey.get(keys[i])];
  }

  /** Entries whose key is `brand` (when withExact) or `brand` + generic words only. */
  function brandHits(idx, brand, withExact) {
    const hits = [];
    if (withExact && idx.byKey.has(brand)) hits.push(idx.byKey.get(brand));
    const head = `${brand} `;
    for (const [key, entry] of withPrefix(idx, head)) {
      if (allGeneric(key.slice(head.length))) hits.push(entry);
    }
    return hits;
  }

  /**
   * Find the listed employer behind a job-board company name.
   * `accept(entry)` narrows the candidates (e.g. to one country's list); a
   * tier only wins with an accepted entry.
   * @returns {{ entry: object|null, match: "exact"|"alias"|"prefix"|"compact"|null, reason: string|null }}
   */
  function find(idx, company, accept = () => true) {
    const keys = nameKeys(company);
    if (!keys.length) return { entry: null, match: null, reason: "NO_COMPANY_NAME" };
    const pick = (hits, match) => {
      const ok = hits.filter(accept);
      return ok.length ? { entry: best(ok), match, reason: null } : null;
    };

    const exact = pick(keys.map((k) => idx.byKey.get(k)).filter(Boolean), "exact");
    if (exact) return exact;

    const heads = new Set(keys);
    for (const k of keys) {
      const w = k.split(" ");
      while (w.length > 1 && generic.has(w[w.length - 1])) w.pop();
      // "Global Services" trimmed to "global" names no brand at all.
      if (!allGeneric(w.join(" "))) heads.add(w.join(" "));
    }

    const alias = pick([...heads].flatMap((h) => (aliases.get(h) || []).flatMap((t) => brandHits(idx, t, true))), "alias");
    if (alias) return alias;

    const prefixHits = [];
    for (const h of heads) {
      if (h.replace(/ /g, "").length < MIN_PREFIX_LEN) continue;
      prefixHits.push(...brandHits(idx, h, !keys.includes(h)));
    }
    const prefix = pick(prefixHits, "prefix");
    if (prefix) return prefix;

    const compact = pick(keys.map(compactKey).filter((c) => c.length >= MIN_COMPACT_LEN)
      .map((c) => idx.byCompact.get(c)).filter(Boolean), "compact");
    if (compact) return compact;

    return { entry: null, match: null, reason: "NOT_LISTED" };
  }

  return { nameKey, nameKeys, compactKey, buildIndex, find };
}
