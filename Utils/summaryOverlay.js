// summaryOverlay: parse + merge candidate-summary markdown.
//
// The candidate brief is plain text with fixed # headers:
//   # Candidate Summary
//   # Target Roles
//   # Hard Constraints
//   # Strong Signals (auto-PICK if matched)
//   # Hard Disqualifiers (auto-SKIP if matched)
//   # Notes for Grader
//
// parseSections(text) → { order:[headers], sections:{header:{bullets,prose}} }
//   bullets : array of bullet lines (each starts with "- " or "* ").
//   prose   : array of non-bullet lines that sit under the header (e.g. the
//             "Preferred roles (verbatim from profile)" line in Target Roles,
//             or the 2-3-sentence overview in Candidate Summary).
//
// mergeOverlay(freshText, overlayText) → mergedText
//   For every section present in BOTH:
//     - keep fresh prose + fresh bullets as-is (AI is authoritative).
//     - append every overlay bullet that is NOT in fresh (exact-match, case
//       + whitespace normalised). These are operator-added sticky lines.
//   For sections that exist in overlay but NOT in fresh: append the whole
//   section at the end (operator added a section the AI dropped).
//   For sections in fresh but NOT in overlay: untouched.
//
// All comparison is on the normalised bullet text (trim + collapse whitespace +
// lowercase) so a stray double-space or trailing period doesn't double-emit.

const BULLET_RE = /^\s*[-*]\s+(.+)$/;
const HEADER_RE = /^\s*#\s+(.+)$/;

// normaliseBullet: collapse whitespace + lowercase for dedupe comparison.
// Strips trailing punctuation that the model occasionally adds/removes
// ("foo." vs "foo") so the same bullet doesn't appear twice.
function normaliseBullet(s) {
    return String(s || "")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[.;,!?]+$/g, "")
        .toLowerCase();
}

// parseSections: split a candidate-brief text into { order, sections }.
//   order    — array of header strings in the order they appear.
//   sections — { [header]: { bullets:[strings], prose:[strings] } }.
// Lines before the first header land in a synthetic "__preamble" key so the
// merge can put them back at the top.
export function parseSections(text) {
    if (typeof text !== "string" || !text.trim()) {
        return { order: [], sections: {} };
    }
    const lines = text.split(/\r?\n/);
    const sections = {};
    const order = [];
    let current = "__preamble";
    sections[current] = { bullets: [], prose: [] };
    for (const raw of lines) {
        const headerMatch = raw.match(HEADER_RE);
        if (headerMatch) {
            current = headerMatch[1].trim();
            if (!sections[current]) {
                sections[current] = { bullets: [], prose: [] };
                order.push(current);
            }
            continue;
        }
        const bulletMatch = raw.match(BULLET_RE);
        if (bulletMatch) {
            sections[current].bullets.push(bulletMatch[1].trim());
            continue;
        }
        if (raw.trim()) sections[current].prose.push(raw);
        else if (sections[current].prose.length || sections[current].bullets.length) {
            sections[current].prose.push("");
        }
    }
    return { order, sections };
}

// extractExtras: given fresh parse + overlay parse, return per-section bullets
// that exist in overlay but not in fresh. These are the operator's additions.
// Returns { [header]: [bullets...] } — only sections with at least one extra.
export function extractExtras(fresh, overlay) {
    const extras = {};
    for (const header of Object.keys(overlay.sections)) {
        if (header === "__preamble") continue;
        const overlayBullets = overlay.sections[header].bullets || [];
        const freshBullets = (fresh.sections[header]?.bullets) || [];
        const freshKeys = new Set(freshBullets.map(normaliseBullet));
        const adds = [];
        for (const b of overlayBullets) {
            if (!freshKeys.has(normaliseBullet(b))) adds.push(b);
        }
        if (adds.length) extras[header] = adds;
    }
    return extras;
}

// stitchSections: build a fresh markdown string from a parsed { order, sections }
// shape. Preserves header order + bullet order; collapses runs of blank prose
// lines to a single blank.
function stitchSections(parsed) {
    const out = [];
    const pre = parsed.sections.__preamble;
    if (pre && (pre.bullets.length || pre.prose.length)) {
        if (pre.prose.length) out.push(pre.prose.join("\n").replace(/\n{3,}/g, "\n\n").trim());
        for (const b of pre.bullets) out.push(`- ${b}`);
        out.push("");
    }
    for (const header of parsed.order) {
        if (header === "__preamble") continue;
        out.push(`# ${header}`);
        const sec = parsed.sections[header];
        if (sec.prose.length) {
            const proseBlock = sec.prose.join("\n").replace(/\n{3,}/g, "\n\n").trim();
            if (proseBlock) out.push(proseBlock);
        }
        for (const b of sec.bullets) out.push(`- ${b}`);
        out.push("");
    }
    return out.join("\n").trim() + "\n";
}

// mergeOverlay: produce a final summary that = fresh AI output + operator's
// sticky bullets re-injected per section.
//   freshText    — text the AI just returned.
//   overlayText  — text the operator saved as their "format snapshot".
// Empty / falsy overlay → freshText unchanged.
export function mergeOverlay(freshText, overlayText) {
    if (!overlayText || typeof overlayText !== "string" || !overlayText.trim()) {
        return freshText;
    }
    if (!freshText || typeof freshText !== "string" || !freshText.trim()) {
        return freshText;
    }
    const fresh = parseSections(freshText);
    const overlay = parseSections(overlayText);
    const extras = extractExtras(fresh, overlay);
    if (!Object.keys(extras).length) return freshText;
    // Append extras per existing section.
    for (const header of Object.keys(extras)) {
        if (!fresh.sections[header]) {
            // Overlay had a section the AI dropped. Append the whole section.
            fresh.sections[header] = { bullets: [...extras[header]], prose: [] };
            fresh.order.push(header);
        } else {
            fresh.sections[header].bullets.push(...extras[header]);
        }
    }
    return stitchSections(fresh);
}

// mergeWithLocks: full merge that respects operator section locks.
//   freshText      — AI output.
//   overlayText    — operator's saved snapshot.
//   lockedSections — array of header strings to replace verbatim.
// For each locked header: overlay's section body REPLACES fresh's section
// body entirely. Locked sections are authoritative — no AI override.
// Unlocked sections: run mergeOverlay (sticky bullets appended).
export function mergeWithLocks(freshText, overlayText, lockedSections = []) {
    if (!overlayText || typeof overlayText !== "string" || !overlayText.trim()) {
        return freshText;
    }
    if (!freshText || typeof freshText !== "string" || !freshText.trim()) {
        return freshText;
    }
    const lockedSet = new Set(
        (Array.isArray(lockedSections) ? lockedSections : [])
            .map((h) => String(h || "").trim())
            .filter(Boolean),
    );
    if (lockedSet.size === 0) {
        return mergeOverlay(freshText, overlayText);
    }
    const fresh = parseSections(freshText);
    const overlay = parseSections(overlayText);
    for (const header of lockedSet) {
        if (overlay.sections[header]) {
            const overlaySec = overlay.sections[header];
            fresh.sections[header] = {
                bullets: [...overlaySec.bullets],
                prose: [...overlaySec.prose],
            };
            if (!fresh.order.includes(header)) fresh.order.push(header);
        }
    }
    const stitched = stitchSections(fresh);
    return mergeOverlay(stitched, overlayText);
}

// PROVENANCE_RE matches a trailing source marker on a bullet/prose line.
// The model emits ` [R]` (resume), ` [P]` (profile), ` [RP]` (both), or
// ` [I]` (inferred from inputs). Tolerates `[r]/[p]/[rp]/[i]` casing + extra
// whitespace before the closing bracket.
const PROVENANCE_RE = /\s*\[(R|P|RP|I)\]\s*$/i;

function normProvCode(code) {
    const u = String(code || "").toUpperCase();
    if (u === "RP" || u === "PR") return "RP";
    if (u === "R" || u === "P" || u === "I") return u;
    return "I";
}

// extractProvenance: strip [R]/[P]/[RP]/[I] markers off bullet + prose lines
// and return the clean text, a per-section index of source codes, and a
// CONTENT-KEYED map of line → code.
//   text — raw AI output with markers.
// Returns { cleanText, provenance: { [header]: { bullets:[code...], prose:[code...] } }, index: Map }.
// Lines with NO marker get "I" (inferred) so the UI can render neutral.
// `noResume:true` flag forces every marker to "P" since a profile-only build
// cannot legitimately cite the resume — useful as a guard after the strip.
//
// The positional `provenance` is only valid for THIS exact text. The build
// pipeline rewrites the brief several times after this runs (notes pass,
// overlay merge, the two deterministic enforce passes), and the UI indexes
// provenance positionally — so the pipeline must re-derive it from the FINAL
// text via provenanceForText(finalText, index). `index` is what survives
// those rewrites, because it is keyed on the line content, not its position.
export function extractProvenance(text, { noResume = false } = {}) {
    if (typeof text !== "string" || !text.trim()) {
        return { cleanText: text || "", provenance: {}, index: new Map() };
    }
    const lines = text.split(/\r?\n/);
    const provenance = {};
    const index = new Map();
    let current = "__preamble";
    provenance[current] = { bullets: [], prose: [] };
    const cleanLines = [];
    for (const raw of lines) {
        const headerMatch = raw.match(HEADER_RE);
        if (headerMatch) {
            current = headerMatch[1].trim();
            if (!provenance[current]) provenance[current] = { bullets: [], prose: [] };
            cleanLines.push(raw);
            continue;
        }
        const bulletMatch = raw.match(BULLET_RE);
        const provMatch = raw.match(PROVENANCE_RE);
        let code = provMatch ? normProvCode(provMatch[1]) : "I";
        if (noResume && code === "R") code = "P";
        if (noResume && code === "RP") code = "P";
        const cleaned = provMatch ? raw.replace(PROVENANCE_RE, "") : raw;
        if (bulletMatch) provenance[current].bullets.push(code);
        else if (raw.trim()) provenance[current].prose.push(code);
        if (cleaned.trim()) {
            // Key on the bullet BODY (markers + list marker stripped) so the
            // same fact still resolves after stitchSections rewrites "* x" to
            // "- x" or the notes pass moves the line to another section.
            const body = cleaned.match(BULLET_RE)?.[1] ?? cleaned;
            const key = normaliseBullet(body);
            if (key && !index.has(key)) index.set(key, code);
        }
        cleanLines.push(cleaned);
    }
    return { cleanText: cleanLines.join("\n"), provenance, index };
}

// provenanceForText: rebuild the positional provenance map the UI consumes
// (ClientAiSummary.jsx walks `[header].bullets[i]` / `.prose[i]` in render
// order) from the FINAL brief plus the content-keyed index captured at
// extraction time.
//
// Every line the model originally marked keeps its true source. Any line that
// is NOT in the index was introduced after the AI wrote the brief — by the
// operator-notes pass, the saved overlay, or the deterministic enforce passes
// — so it is attributed to "U" (Operator) rather than silently inheriting a
// neighbour's colour. Walk order mirrors the UI's parser exactly.
export function provenanceForText(text, index) {
    const provenance = {};
    if (typeof text !== "string" || !text.trim()) return provenance;
    const map = index instanceof Map ? index : new Map();
    let current = "__preamble";
    provenance[current] = { bullets: [], prose: [] };
    for (const raw of text.split(/\r?\n/)) {
        const headerMatch = raw.match(HEADER_RE);
        if (headerMatch) {
            current = headerMatch[1].trim();
            if (!provenance[current]) provenance[current] = { bullets: [], prose: [] };
            continue;
        }
        if (!raw.trim()) continue; // blank lines are skipped by the UI too
        const bulletMatch = raw.match(BULLET_RE);
        const body = bulletMatch ? bulletMatch[1] : raw;
        const code = map.get(normaliseBullet(body)) || "U";
        if (bulletMatch) provenance[current].bullets.push(code);
        else provenance[current].prose.push(code);
    }
    return provenance;
}

// countOverlayBullets: count operator additions per section relative to the
// current `aiSummary` text. Used by the UI to show "+3 sticky lines".
//   overlayText — saved overlay snapshot.
//   currentText — current aiSummary (for UI delta vs live).
// Returns { total:number, perSection:{ [header]: number } }.
export function countOverlayBullets(overlayText, currentText) {
    if (!overlayText || !overlayText.trim()) return { total: 0, perSection: {} };
    const overlay = parseSections(overlayText);
    const current = parseSections(currentText || "");
    let total = 0;
    const perSection = {};
    for (const header of Object.keys(overlay.sections)) {
        if (header === "__preamble") continue;
        const overlayBullets = overlay.sections[header].bullets || [];
        const currentBullets = (current.sections[header]?.bullets) || [];
        const currentKeys = new Set(currentBullets.map(normaliseBullet));
        let n = 0;
        for (const b of overlayBullets) {
            if (!currentKeys.has(normaliseBullet(b))) n += 1;
        }
        if (n) {
            perSection[header] = n;
            total += n;
        }
    }
    return { total, perSection };
}
