// Europe run: who counts as a Europe client, and the reminder text.
import test from "node:test";
import assert from "node:assert/strict";
import { europeanLocations, roleTerms, getEuropeClients, withEuropeSources, ensureEuropeSources } from "../europeClients.js";
import { reminderText, postToDiscord } from "../europeRunReminder.js";

test("countries, cities and Europe/EU all count; the UK counts", () => {
  assert.deepEqual(europeanLocations(["Netherlands"]).countries, ["nl"]);
  assert.deepEqual(europeanLocations(["United Kingdom"]).countries, ["gb"]);
  assert.deepEqual(europeanLocations(["London, UK"]).countries, ["gb"]);
  assert.deepEqual(europeanLocations(["Maribor, Slovenia", "Finland"]).countries, ["si", "fi"]);
  const eu = europeanLocations(["EU/ Australia/Canada"]);
  assert.equal(eu.isEurope, true, "'EU' marks a Europe client");
  assert.deepEqual(eu.countries, [], "no concrete European country to give Glassdoor");
  assert.deepEqual(eu.places, []);
});

test("non-European locations are not Europe clients", () => {
  for (const loc of [["United States"], ["Dubai, UAE"], ["Toronto, Canada"], ["India"], [], [""]]) {
    assert.equal(europeanLocations(loc).isEurope, false, JSON.stringify(loc));
  }
});

test("a European city name beside non-European places is not Europe (Cambridge, Ontario)", () => {
  const gta = europeanLocations(["Greater Toronto Area, Toronto, Oakville, Etobicoke, Cambridge."]);
  assert.equal(gta.isEurope, false);
  assert.deepEqual(gta.countries, []);
  assert.equal(europeanLocations(["London, Ontario"]).isEurope, false);
  assert.equal(europeanLocations(["Birmingham, Alabama"]).isEurope, false);
  // City alone, city lists, city + Remote, and city + European country still count.
  assert.deepEqual(europeanLocations(["Cambridge"]).countries, ["gb"]);
  assert.deepEqual(europeanLocations(["Berlin, Munich"]).countries, ["de"]);
  assert.deepEqual(europeanLocations(["Berlin, Remote"]).countries, ["de"]);
  assert.deepEqual(europeanLocations(["Cambridge, UK"]).countries, ["gb"]);
  assert.equal(europeanLocations(["Toronto", "London"]).isEurope, false, "Toronto anywhere makes a bare London ambiguous");
  assert.deepEqual(europeanLocations(["Toronto", "London, UK"]).countries, ["gb"], "a European country still counts");
  assert.equal(europeanLocations(["Greater Boston", "MA; Cambridge", "MA"]).isEurope, false);
  // UK lists with towns the city table does not know stay Europe.
  assert.deepEqual(europeanLocations(["London, Nottingham, Reading, Rugby, Coventry"]).countries, ["gb"]);
  assert.deepEqual(europeanLocations(["Paris, Le havre"]).countries, ["fr"]);
});

test("places keep the client's wording for HiringCafe, minus non-European entries", () => {
  const r = europeanLocations(["Dubai", "London, United Kingdom", "Remote"]);
  assert.deepEqual(r.places, ["London, United Kingdom"]);
});

test("roles are split on | , / and de-duplicated", () => {
  assert.deepEqual(
    roleTerms(["Test Automation | Framework Design | CI/CD", "test automation, QA Lead"]),
    ["Test Automation", "Framework Design", "CI", "CD", "QA Lead"],
  );
  assert.equal(roleTerms(["a,b,c,d,e,f,g,h,i,j"]).length, 8);
});

function fakeModel(rows) {
  const q = { lean: async () => rows, select() { return q; } };
  return { find: () => q };
}

test("only active, unpaused clients with clientCountry \"Europe\" are returned", async () => {
  const ProfileModel = fakeModel([
    { email: "nl@x.com", firstName: "Vipin", lastName: "S", preferredLocations: ["Netherlands"], preferredRoles: ["QA"] },
    { email: "us@x.com", firstName: "Us", lastName: "A", preferredLocations: ["United States"], preferredRoles: ["QA"] },
    { email: "paused@x.com", firstName: "P", lastName: "Z", preferredLocations: ["Germany"], preferredRoles: ["QA"] },
    { email: "gone@x.com", firstName: "G", lastName: "Z", preferredLocations: ["France"], preferredRoles: ["QA"] },
    { email: "new@x.com", firstName: "New", lastName: "C", preferredLocations: ["Ireland"], preferredRoles: [] },
    { email: "uk@x.com", firstName: "Uk", lastName: "C", preferredLocations: ["London, UK"], preferredRoles: [] },
    { email: "ca@x.com", firstName: "Ca", lastName: "C", preferredLocations: ["Toronto, Cambridge"], preferredRoles: [] },
    { email: "nocountry@x.com", firstName: "N", lastName: "C", preferredLocations: ["Germany"], preferredRoles: [] },
  ]);
  const ClientPaymentLookup = fakeModel([
    { email: "nl@x.com", name: "Vipin Saxena", status: "active", clientCountry: "Europe" },
    { email: "us@x.com", status: "active", clientCountry: "USA" },
    { email: "paused@x.com", status: "active", isPaused: true, clientCountry: "Europe" },
    { email: "gone@x.com", status: "inactive", clientCountry: "Europe" },
    { email: "new@x.com", status: "Active", clientCountry: "Europe" },
    { email: "uk@x.com", status: "active", clientCountry: "UK" },
    { email: "ca@x.com", status: "active", clientCountry: "Canada" },
    { email: "nocountry@x.com", status: "active" },
  ]);
  const out = await getEuropeClients({ ProfileModel, ClientPaymentLookup });
  // UK, Canada and a client with no country set are out, whatever their locations say.
  assert.deepEqual(out.map((c) => c.email), ["new@x.com", "nl@x.com"]);
  const v = out.find((c) => c.email === "nl@x.com");
  assert.equal(v.name, "Vipin Saxena");
  assert.equal(v.country, "nl", "locations still pick where to search");
  assert.deepEqual(v.roles, ["QA"]);
});

test("reminder names every client and stays under Discord's limit", () => {
  const few = reminderText([{ name: "Vipin Saxena", countries: ["nl"] }]);
  assert.match(few, /Europe run: 1 client today/);
  assert.match(few, /Vipin Saxena \(NL\)/);
  assert.match(few, /Run Europe clients/);
  const many = reminderText(Array.from({ length: 400 }, (_, i) => ({ name: `Client number ${i}`, countries: ["de"] })));
  assert.ok(many.length <= 1900, `length ${many.length}`);
  assert.match(many, /…and \d+ more/);
});

test("a client set to Europe in Client Tracking counts even without European locations", async () => {
  const ProfileModel = fakeModel([
    { email: "eu@x.com", firstName: "Eu", lastName: "C", preferredLocations: [], preferredRoles: ["Buyer"] },
  ]);
  const ClientPaymentLookup = fakeModel([{ email: "eu@x.com", status: "active", clientCountry: "Europe" }]);
  const out = await getEuropeClients({ ProfileModel, ClientPaymentLookup });
  assert.deepEqual(out.map((c) => c.email), ["eu@x.com"]);
  assert.equal(out[0].country, "");
});

test("Europe sources are added to what is there, never removing anything", () => {
  assert.deepEqual(withEuropeSources(undefined), ["jobright", "indeed", "glassdoor", "hiringcafe"]);
  assert.deepEqual(withEuropeSources([]), ["jobright", "indeed", "glassdoor", "hiringcafe"]);
  assert.deepEqual(withEuropeSources(["reed", "Indeed"]), ["reed", "indeed", "glassdoor", "hiringcafe"]);
  assert.deepEqual(withEuropeSources(["hiringcafe", "glassdoor", "indeed"]), ["hiringcafe", "glassdoor", "indeed"]);
});

test("ensureEuropeSources writes once, only for clients missing a board", async () => {
  const calls = [];
  const ProfileModel = { bulkWrite: async (ops) => { calls.push(ops); return { modifiedCount: ops.length }; } };
  const clients = [
    { email: "done@x.com", scrapeSources: ["jobright", "indeed", "glassdoor", "hiringcafe"] },
    { email: "none@x.com", scrapeSources: [] },
    { email: "some@x.com", scrapeSources: ["reed"] },
  ];
  assert.equal(await ensureEuropeSources({ ProfileModel, clients }), 2);
  assert.equal(calls.length, 1, "one bulkWrite, not one call per client");
  assert.deepEqual(calls[0].map((o) => o.updateOne.filter.email), ["none@x.com", "some@x.com"]);
  assert.equal(await ensureEuropeSources({ ProfileModel, clients: [clients[0]] }), 0);
  assert.equal(calls.length, 1, "nothing to change means no write");
});

test("Europe-run Discord posts are off unless EUROPE_RUN_DISCORD_ENABLED=1", async () => {
  const calls = [];
  const post = async (...a) => { calls.push(a); };
  const off = await postToDiscord("hi", { post, env: {} });
  assert.equal(off.sent, false);
  assert.equal(calls.length, 0, "nothing reaches Discord by default");
  const still = await postToDiscord("hi", { post, env: { EUROPE_RUN_DISCORD_ENABLED: "0" } });
  assert.equal(still.sent, false);
  assert.equal(calls.length, 0);
});
