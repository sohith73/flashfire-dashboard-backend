/**
 * Canonical key for a job application URL, used to detect the same posting
 * arriving twice for one client.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four code paths create jobs and no two agreed on what "duplicate" meant:
 *
 *   /addjob, /api/jobs          CheckForDuplicateJobs — title + company only
 *   /operations/jobs            no check at all
 *   /storejobanduserdetails     exact string equality on joblink
 *   /extension/saveToDashboard  title + company only
 *
 * So one shared application form (a Tally link, a company careers portal, a
 * Greenhouse board used for several roles) lands once per distinct title, and
 * the operator sees the same URL five times. Exact string equality does not
 * help either: ?utm_source=linkedin, a trailing slash, or a www. prefix each
 * produce a "new" job.
 *
 * This normalises away everything that cannot change which posting a URL points
 * at, and nothing that can.
 *
 * WHAT IS DELIBERATELY KEPT
 * -------------------------
 * Query parameters are the dangerous part. Most ATS platforms put the job
 * identity IN the query string, so stripping the lot would collapse an entire
 * company's board into one key and silently block real jobs. gh_jid (Greenhouse
 * job id), jobId, requisitionId and friends are therefore preserved; only
 * parameters that describe where the click came FROM are removed.
 */

/**
 * Query parameters that record traffic attribution rather than job identity.
 * Removing these is always safe. Adding to this list is not: anything that
 * identifies WHICH job must stay, or two different postings collapse into one
 * key and the second is rejected as a duplicate.
 *
 * Note gh_src is here but gh_jid is NOT. Greenhouse uses gh_src for the source
 * token and gh_jid for the job id; they look alike and mean opposite things.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_cid', 'utm_reader', 'utm_referrer',
  'gh_src', 'lever_source', 'lever-source', 'ashby_jid_source',
  'ref', 'referer', 'referrer', 'refid', 'source', 'src', 'trk', 'trackingid',
  'fbclid', 'gclid', 'msclkid', 'dclid', 'twclid', 'igshid', 'mc_cid', 'mc_eid',
  '_ga', '_gl', 'yclid', 'wbraid', 'gbraid', 'originalsubdomain',
  'recruiter', 'campaignid', 'adgroupid',
]);

/**
 * Links that carry no identity at all. These are schema defaults and operator
 * placeholders, not real postings, and they repeat across hundreds of rows.
 * They must never be treated as duplicates of one another.
 */
const PLACEHOLDER_RX = /^(?:https?:\/\/)?(?:www\.)?(?:google\.com|example\.com|n\/?a|none|null|undefined|-)\/?$/i;

/**
 * Reduce a job URL to a stable comparison key.
 *
 * Returns '' for anything that cannot identify a posting (empty, whitespace, or
 * a known placeholder). Callers MUST treat '' as "cannot compare" and skip the
 * duplicate check rather than matching all the blanks against each other.
 *
 * @param {unknown} raw
 * @returns {string} canonical key, or '' when the link carries no identity
 */
export function jobLinkKey(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return '';
  if (PLACEHOLDER_RX.test(input)) return '';

  // Scheme detection has to happen BEFORE parsing, and cannot rely on "://".
  // "mailto:jobs@acme.com" has a scheme and no slashes; blindly prepending
  // https:// to it parses the address as userinfo and yields the host acme.com,
  // so a mailto link would have been keyed as though it were that company's
  // careers site. The negative lookahead for a digit keeps "acme.com:8080/jobs"
  // out of this branch, where the colon introduces a port and not a scheme.
  const schemeMatch = input.match(/^([a-z][a-z0-9+.-]*):(?!\d)/i);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) return '';

  let url;
  try {
    // Bare hosts ("careers.acme.com/jobs/1") are common in pasted input and
    // throw without a scheme, so add one before parsing.
    url = new URL(schemeMatch ? input : `https://${input}`);
  } catch {
    // Unparseable. Fall back to a squashed string so two identical pastes still
    // match each other, rather than giving up and allowing the duplicate.
    return input.toLowerCase().replace(/\s+/g, '').replace(/\/+$/, '');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  // `host` rather than `hostname` so a non-default port stays in the key. Two
  // services on one machine differing only by port are different sites, and
  // dropping the port would collapse them together.
  const host = url.host.toLowerCase().replace(/^www\./, '');
  if (!host || PLACEHOLDER_RX.test(host)) return '';

  // Trailing slashes are cosmetic. Case in the path is NOT: plenty of ATS
  // routes are case-sensitive, so the path is left exactly as given.
  const path = url.pathname.replace(/\/+$/, '');

  // Sorted so ?a=1&b=2 and ?b=2&a=1 produce one key.
  const params = [];
  for (const [k, v] of url.searchParams) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    params.push([k, v]);
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');

  // The fragment is never sent to the server, so it cannot select a posting.
  return query ? `${host}${path}?${query}` : `${host}${path}`;
}

/**
 * How many DIFFERENT employer names one URL may be recorded under before it is
 * treated as a shared application form rather than a job posting.
 *
 * Measured, not guessed. Over 79,469 jobs added in 120 days the distribution of
 * distinct company names per canonical link was:
 *
 *     2 companies : 1139 links      4 companies :    7 links
 *     3 companies :   66 links      5 companies :    1 link
 *    11 companies :    2 links     48 companies :    1 link
 *
 * Everything at 4 and below is one employer spelled several ways — "paypal" /
 * "paypal, inc." / "0020 paypal, inc.", or "baker tilly" / "baker tilly us".
 * The 5 is one company with five spellings too. The outliers at 11, 11 and 48
 * are all tally.so forms recorded under genuinely unrelated employers: travel
 * agencies, logistics firms, media companies. One URL cannot be six unrelated
 * employers, so 6 separates them with room to spare in both directions.
 */
export const SHARED_FORM_COMPANY_LIMIT = 6;

/**
 * Everything the add paths need to know about a link, in one round trip.
 *
 * Answers two different questions that need two different rules:
 *
 *   duplicateForClient  Has THIS client already got this link? Scoped to one
 *                       client on purpose — two clients applying to the same
 *                       real posting is normal and must never be blocked.
 *
 *   companyCount        How many distinct employers is this URL recorded under,
 *                       across everyone? A generic form reused by dozens of
 *                       fake postings shows up here and nowhere else. This one
 *                       IS cross-client, because that is the only place the
 *                       signal exists.
 *
 * @param {import('mongoose').Model} JobModel
 * @param {string} userID
 * @param {unknown} rawLink
 * @returns {Promise<{key: string, duplicateForClient: object|null, companyCount: number, clientCount: number, companies: string[]}>}
 */
export async function inspectJobLink(JobModel, userID, rawLink) {
  const empty = { key: '', duplicateForClient: null, companyCount: 0, clientCount: 0, companies: [] };
  const key = jobLinkKey(rawLink);
  if (!key) return empty;
  const email = String(userID || '').trim().toLowerCase();
  if (!email) return empty;

  const lowerUser = { $toLower: { $trim: { input: { $ifNull: ['$userID', ''] } } } };

  const [agg] = await JobModel.aggregate([
    { $match: { joblinkKey: key } },
    {
      $group: {
        _id: null,
        companies: { $addToSet: { $toLower: { $trim: { input: { $ifNull: ['$companyName', ''] } } } } },
        clients: { $addToSet: lowerUser },
        // The client's own copies, collected in the same pass rather than a
        // second query. null for everyone else's rows; stripped below.
        mine: {
          $addToSet: {
            $cond: [
              { $eq: [lowerUser, email] },
              { jobID: '$jobID', jobTitle: '$jobTitle', companyName: '$companyName', currentStatus: '$currentStatus', dateAdded: '$dateAdded' },
              null,
            ],
          },
        },
      },
    },
  ]);

  if (!agg) return { ...empty, key };

  const mine = (agg.mine || []).filter(Boolean);
  const companies = (agg.companies || []).filter((c) => c !== '');
  return {
    key,
    duplicateForClient: mine[0] || null,
    companyCount: companies.length,
    clientCount: (agg.clients || []).length,
    companies,
  };
}

/**
 * Convenience wrapper for callers that only care about the per-client duplicate.
 *
 * @param {import('mongoose').Model} JobModel
 * @param {string} userID
 * @param {unknown} rawLink
 * @returns {Promise<object|null>} the existing job, or null
 */
export async function findDuplicateByLink(JobModel, userID, rawLink) {
  const { duplicateForClient } = await inspectJobLink(JobModel, userID, rawLink);
  return duplicateForClient;
}
