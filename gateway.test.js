import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, configuredKeys } from "../src/index.js";

const TOKEN = "test-gateway-token-that-is-at-least-32-chars-long";
const env = { GATEWAY_TOKEN: TOKEN, ANTHROPIC_API_KEY_1: "key-one" };
const request = (path = "/v1/messages", options = {}) => new Request(`https://gateway.example${path}`, options);
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const body = JSON.stringify({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });

test("selects configured keys in stable slot order and skips empty values", () => {
  assert.deepEqual(configuredKeys({ ANTHROPIC_API_KEY_2: " second ", ANTHROPIC_API_KEY_1: "", ANTHROPIC_API_KEY_3: "third" }), [
    { slot: 2, value: "second" }, { slot: 3, value: "third" },
  ]);
});

test("health endpoint is reachable without upstream credentials", async () => {
  const response = await handleRequest(request("/health"), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("rejects unknown routes and wrong methods", async () => {
  assert.equal((await handleRequest(request("/anything", { method: "POST" }), env)).status, 404);
  assert.equal((await handleRequest(request("/v1/messages", { method: "GET" }), env)).status, 405);
});

test("rejects missing and incorrect gateway tokens", async () => {
  assert.equal((await handleRequest(request("/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body }), env)).status, 401);
  assert.equal((await handleRequest(request("/v1/messages", { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" }, body }), env)).status, 401);
});

test("rejects malformed JSON and missing required message fields", async () => {
  assert.equal((await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body: "{" }), env)).status, 400);
  assert.equal((await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body: "{}" }), env)).status, 400);
});

test("passes request JSON and required upstream headers; streams response body", async () => {
  let seen;
  const fakeFetch = async (url, options) => {
    seen = { url, options };
    return new Response('{"type":"message","content":[]}', { status: 200, headers: { "content-type": "application/json" } });
  };
  const response = await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body }), env, fakeFetch);
  assert.equal(response.status, 200);
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.options.headers["x-api-key"], "key-one");
  assert.equal(seen.options.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.options.body, body);
  assert.equal(await response.text(), '{"type":"message","content":[]}');
});

test("does not fail over on 429", async () => {
  let calls = 0;
  const response = await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body }), {
    ...env, ANTHROPIC_API_KEY_2: "key-two",
  }, async () => { calls++; return new Response('{"error":{"type":"rate_limit_error","message":"slow down"}}', { status: 429, headers: { "content-type": "application/json" } }); });
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

test("fails over on transient upstream 503 for non-streaming requests", async () => {
  let calls = 0;
  const response = await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body }), {
    ...env, ANTHROPIC_API_KEY_2: "key-two",
  }, async (_url, options) => {
    calls++;
    if (calls === 1) return new Response("unavailable", { status: 503 });
    assert.equal(options.headers["x-api-key"], "key-two");
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("does not retry streaming requests", async () => {
  let calls = 0;
  const streamBody = JSON.stringify({ model: "claude-test", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] });
  const response = await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body: streamBody }), {
    ...env, ANTHROPIC_API_KEY_2: "key-two",
  }, async () => { calls++; return new Response("unavailable", { status: 503 }); });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test("does not expose key in response on network failure", async () => {
  const response = await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body }), env, async () => { throw new Error("secret key-one leaked"); });
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes("key-one"), false);
});

test("returns a safe error when no upstream keys exist", async () => {
  const response = await handleRequest(request("/v1/messages", { method: "POST", headers: auth, body }), { GATEWAY_TOKEN: TOKEN });
  assert.equal(response.status, 503);
});
