// Covers Utils/clientCurrency.js: the Choose a Plan page prices a client in the
// country clients-tracking has for them, not in users.currency's "USD" default.

import test from "node:test";
import assert from "node:assert/strict";
import { clientCurrency } from "../clientCurrency.js";

test("the tracked country sets the currency", () => {
  assert.equal(clientCurrency({ clientCountry: "UK", amountPaid: "309" }, undefined), "GBP");
  assert.equal(clientCurrency({ clientCountry: "Europe" }, "USD"), "EUR");
  assert.equal(clientCurrency({ clientCountry: "Australia" }, null), "AUD");
  assert.equal(clientCurrency({ clientCountry: "Canada" }, ""), "CAD");
  assert.equal(clientCurrency({ clientCountry: "USA" }, "INR"), "USD");
});

test("with no country set, the payment prefix decides", () => {
  assert.equal(clientCurrency({ amountPaid: "£419" }, undefined), "GBP");
  assert.equal(clientCurrency({ amountPaid: "€199" }, undefined), "EUR");
  assert.equal(clientCurrency({ amountPaid: "CAD 349" }, undefined), "CAD");
});

test("with no tracking row, the stored currency is kept, else USD", () => {
  assert.equal(clientCurrency(null, "gbp"), "GBP");
  assert.equal(clientCurrency(undefined, undefined), "USD");
  assert.equal(clientCurrency({ amountPaid: "309" }, undefined), "USD");
});
