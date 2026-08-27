import assert from "node:assert/strict";
import test from "node:test";
import { extractCredentialsFromOutput } from "../src/credential-parser.js";

const ctx = { scopeRef: "scope:test" };
const ctxWithHost = { scopeRef: "scope:test", hostRef: "10.0.0.1" };

test("extracts Cookie header", () => {
  const output = "GET / HTTP/1.1\r\nCookie: session=abc123; lang=en\r\nHost: example.com";
  const results = extractCredentialsFromOutput(output, ctx);
  const sessionCookie = results.find((r) => r.name === "session" && r.value === "abc123");
  assert.ok(sessionCookie, "should extract session cookie");
  assert.equal(sessionCookie.kind, "cookie");
});

test("extracts Set-Cookie header", () => {
  const output = "HTTP/1.1 200 OK\r\nSet-Cookie: token=xyz; Path=/; HttpOnly\r\n";
  const results = extractCredentialsFromOutput(output, ctx);
  const tokenCookie = results.find((r) => r.name === "token" && r.value === "xyz");
  assert.ok(tokenCookie, "should extract Set-Cookie token");
  assert.equal(tokenCookie.kind, "cookie");
});

test("extracts Authorization Bearer token", () => {
  const output = "GET /api HTTP/1.1\r\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig\r\n";
  const results = extractCredentialsFromOutput(output, ctx);
  const bearer = results.find((r) => r.name === "Bearer");
  assert.ok(bearer, "should extract Bearer token");
  assert.equal(bearer.kind, "token");
  assert.equal(bearer.value, "eyJhbGciOiJIUzI1NiJ9.payload.sig");
});

test("extracts Authorization Basic credentials", () => {
  const output = "GET / HTTP/1.1\r\nAuthorization: Basic dXNlcjpwYXNz\r\n";
  const results = extractCredentialsFromOutput(output, ctx);
  const basic = results.find((r) => r.name === "Basic");
  assert.ok(basic, "should extract Basic auth");
  assert.equal(basic.kind, "token");
  assert.equal(basic.value, "dXNlcjpwYXNz");
});

test("extracts JSON access_token field", () => {
  const output = '{"access_token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9", "token_type": "bearer"}';
  const results = extractCredentialsFromOutput(output, ctx);
  const token = results.find((r) => r.name === "access_token");
  assert.ok(token, "should extract access_token from JSON");
  assert.equal(token.kind, "json_field");
  assert.equal(token.value, "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9");
});

test("extracts SSH private key", () => {
  const output = [
    "some output before",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA",
    "hQWPLtDHQKECP5q+oIj2kG0cB0ZqXH",
    "-----END RSA PRIVATE KEY-----",
    "some output after"
  ].join("\n");
  const results = extractCredentialsFromOutput(output, ctx);
  const key = results.find((r) => r.kind === "private_key");
  assert.ok(key, "should extract SSH private key");
  assert.equal(key.name, "RSA_PRIVATE_KEY");
  assert.match(key.value, /-----BEGIN RSA PRIVATE KEY-----/);
  assert.match(key.value, /-----END RSA PRIVATE KEY-----/);
});

test("extracts multiple credentials from mixed output", () => {
  const output = [
    "HTTP/1.1 200 OK",
    "Set-Cookie: session_id=abcdef123456; Path=/",
    "",
    '{"access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}',
    "",
    "-----BEGIN EC PRIVATE KEY-----",
    "MHQCAQEEIBkg4LVWM9nuwNSk3yByxZpYRTBnVJk5",
    "-----END EC PRIVATE KEY-----"
  ].join("\n");
  const results = extractCredentialsFromOutput(output, ctx);
  assert.ok(results.length >= 3, `should extract at least 3 credentials, got ${results.length}`);
  assert.ok(results.some((r) => r.name === "session_id"));
  assert.ok(results.some((r) => r.name === "access_token"));
  assert.ok(results.some((r) => r.kind === "private_key"));
});

test("returns empty array for empty input", () => {
  const results = extractCredentialsFromOutput("", ctx);
  assert.deepEqual(results, []);
});

test("returns empty array for plain text without credentials", () => {
  const output = "This is just a normal log line with no sensitive data.\nAnother normal line.";
  const results = extractCredentialsFromOutput(output, ctx);
  assert.deepEqual(results, []);
});

test("propagates hostRef from context to results", () => {
  const output = "Cookie: session=abc123\r\n";
  const results = extractCredentialsFromOutput(output, ctxWithHost);
  assert.ok(results.length > 0);
  for (const result of results) {
    assert.equal(result.hostRef, "10.0.0.1");
  }
});

test("omits hostRef when not provided in context", () => {
  const output = "Cookie: session=abc123\r\n";
  const results = extractCredentialsFromOutput(output, ctx);
  assert.ok(results.length > 0);
  for (const result of results) {
    assert.equal(result.hostRef, undefined);
  }
});

test("deduplicates identical credentials", () => {
  const output = "Cookie: session=abc123\r\nCookie: session=abc123\r\n";
  const results = extractCredentialsFromOutput(output, ctx);
  const sessionCookies = results.filter((r) => r.name === "session" && r.value === "abc123");
  assert.equal(sessionCookies.length, 1);
});
