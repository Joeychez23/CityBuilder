// End-to-end API tests against a throwaway in-memory MongoDB (a one-member replica set,
// so retryable writes work like they do on Atlas).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let server, base, mongod;

before(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongod.getUri().split("?")[0];
  process.env.MONGODB_DB = "gridlock_city_test";
  process.env.JWT_SECRET = "test-secret-not-for-production";
  const db = require("../db");
  const app = require("../index");
  await db.connect();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  server?.close();
  await require("mongoose").disconnect();
  await mongod?.stop();
});

async function call(path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data };
}

const SAVE = `GZ:${Buffer.from("x".repeat(300000)).toString("base64")}`; // ~400 KB, like a real save

let alice, bob, cityId;

test("health reports accounts available", async () => {
  const { data } = await call("/health");
  assert.equal(data.accounts, true);
});

test("register, reject duplicates, log in", async () => {
  const r = await call("/auth/register", { method: "POST", body: { email: "Alice@Example.com", password: "correct horse", name: "Alice" } });
  assert.equal(r.status, 201);
  assert.ok(r.data.token);
  assert.equal(r.data.user.email, "alice@example.com");
  alice = r.data.token;
  assert.equal((await call("/auth/register", { method: "POST", body: { email: "alice@example.com", password: "another pass" } })).status, 409);
  assert.equal((await call("/auth/register", { method: "POST", body: { email: "bad", password: "correct horse" } })).status, 400);
  assert.equal((await call("/auth/login", { method: "POST", body: { email: "alice@example.com", password: "wrong pass" } })).status, 401);
  const ok = await call("/auth/login", { method: "POST", body: { email: "alice@example.com", password: "correct horse" } });
  assert.equal(ok.status, 200);
  assert.equal((await call("/auth/me", { token: ok.data.token })).data.user.name, "Alice");
  bob = (await call("/auth/register", { method: "POST", body: { email: "bob@example.com", password: "password123" } })).data.token;
});

test("cities need a session", async () => {
  assert.equal((await call("/cities")).status, 401);
  assert.equal((await call("/cities", { token: "not-a-token" })).status, 401);
});

test("save, list, load and update a city", async () => {
  const created = await call("/cities", { method: "POST", token: alice, body: { name: "New Harbor", mapId: "prairie", mapName: "Open Prairie", population: 1234, money: 500000, day: 12, milestone: 3, data: SAVE } });
  assert.equal(created.status, 201);
  cityId = created.data.city.id;
  assert.equal(created.data.city.size, SAVE.length);
  const list = await call("/cities", { token: alice });
  assert.equal(list.data.cities.length, 1);
  assert.equal(list.data.cities[0].data, undefined, "the list shouldn't carry the save itself");
  const loaded = await call(`/cities/${cityId}`, { token: alice });
  assert.equal(loaded.data.city.data, SAVE);
  const updated = await call(`/cities/${cityId}`, { method: "PUT", token: alice, body: { name: "New Harbor II", population: 2000, data: "GZ:abc" } });
  assert.equal(updated.data.city.name, "New Harbor II");
  assert.equal((await call(`/cities/${cityId}`, { token: alice })).data.city.data, "GZ:abc");
});

test("rejects things that aren't saves", async () => {
  assert.equal((await call("/cities", { method: "POST", token: alice, body: { name: "x", data: "<script>" } })).status, 400);
  assert.equal((await call("/cities", { method: "POST", token: alice, body: { name: "x" } })).status, 400);
});

test("other players can't see or change your city", async () => {
  assert.equal((await call(`/cities/${cityId}`, { token: bob })).status, 404);
  assert.equal((await call(`/cities/${cityId}`, { method: "PUT", token: bob, body: { name: "mine now" } })).status, 404);
  assert.equal((await call(`/cities/${cityId}`, { method: "DELETE", token: bob })).status, 404);
  assert.equal((await call("/cities", { token: bob })).data.cities.length, 0);
});

test("delete a city, then the account", async () => {
  assert.equal((await call(`/cities/${cityId}`, { method: "DELETE", token: alice })).status, 204);
  assert.equal((await call(`/cities/${cityId}`, { token: alice })).status, 404);
  await call("/cities", { method: "POST", token: alice, body: { name: "Second", data: "GZ:abc" } });
  assert.equal((await call("/auth/account", { method: "DELETE", token: alice })).status, 204);
  assert.equal((await call("/auth/me", { token: alice })).status, 401);
  const City = require("../models/City");
  assert.equal(await City.countDocuments({}), 0, "deleting the account removes its cities");
});
