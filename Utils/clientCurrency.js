// Which currency a client's dashboard prices (Choose a Plan, boosters) use.
//
// The country is the one ops keep in clients-tracking (dashboardtrackings
// clientCountry, else the amountPaid prefix), read by the same rule the
// Client Job Analysis screen and the visa-sponsor gates use. users.currency
// is only a fallback: it was never filled for most clients, and its schema
// default is "USD", so 76 UK/Europe/Australia/Canada clients saw dollar
// prices and dollar Stripe links (2026-11-12).

import { deriveClientCountry } from "./ukVisaSponsor.js";

const CURRENCY_BY_COUNTRY = {
  USA: "USD",
  Canada: "CAD",
  UK: "GBP",
  Australia: "AUD",
  Europe: "EUR",
};

/**
 * @param {object|null|undefined} trackingDoc dashboardtrackings row ({ clientCountry, amountPaid })
 * @param {string|null|undefined} storedCurrency users.currency
 * @returns {string} ISO code such as "GBP"
 */
export function clientCurrency(trackingDoc, storedCurrency) {
  const { country } = deriveClientCountry(trackingDoc);
  if (CURRENCY_BY_COUNTRY[country]) return CURRENCY_BY_COUNTRY[country];
  const stored = String(storedCurrency || "").trim().toUpperCase();
  return stored || "USD";
}
