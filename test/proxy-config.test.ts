import assert from "node:assert/strict";
import test from "node:test";
import { parseTransparentProxy, transparentProxyEndpoint } from "../src/proxy-config.js";

test("parses an authenticated SOCKS5 transparent proxy", () => {
  const proxy = parseTransparentProxy("socks5://user:p%40ss@192.0.2.8:10800");
  assert.deepEqual(proxy, {
    host: "192.0.2.8",
    port: 10800,
    username: "user",
    password: "p@ss"
  });
  assert.equal(transparentProxyEndpoint(proxy), "192.0.2.8:10800");
});

test("uses the standard SOCKS port and rejects unsupported proxy shapes", () => {
  assert.equal(parseTransparentProxy("socks5://user:pass@proxy.example.test").port, 1080);
  assert.throws(() => parseTransparentProxy("http://user:pass@proxy.example.test"), /only socks5/);
  assert.throws(() => parseTransparentProxy("socks5://proxy.example.test"), /username and password/);
  assert.throws(() => parseTransparentProxy("socks5://user:pass@proxy.example.test/path"), /must not contain/);
});
