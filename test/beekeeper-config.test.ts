import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  beekeeperChildEnvironment,
  loadBeekeeperConfig
} from "../src/beekeeper/beekeeper-config.js";

test("Beekeeper MCP stays disabled unless explicitly enabled", () => {
  assert.equal(loadBeekeeperConfig({}, "/repo"), undefined);
  assert.equal(loadBeekeeperConfig({ BEEKEEPER_MCP_ENABLED: "0" }, "/repo"), undefined);
});

test("Beekeeper MCP config uses bounded defaults when enabled", () => {
  const config = loadBeekeeperConfig({ BEEKEEPER_MCP_ENABLED: "1" }, "/repo")!;

  assert.equal(config.root, "/repo/vendor/Beekeeper");
  assert.equal(config.pythonCommand, "/repo/.beekeeper-mcp-venv/bin/python");
  assert.equal(config.entryPoint, "/repo/scripts/beekeeper-mcp-adapter.py");
  assert.equal(config.maxPageSize, 50);
  assert.equal(config.requestTimeoutMs, 15_000);
  assert.equal(config.databaseUrl, undefined);
});

test("Beekeeper MCP config accepts explicit paths and clamps invalid positive integers", () => {
  const root = resolve("/tmp/beekeeper-root");
  const config = loadBeekeeperConfig({
    BEEKEEPER_MCP_ENABLED: "1",
    BEEKEEPER_ROOT: root,
    BEEKEEPER_MCP_PYTHON: `${root}/venv/bin/python`,
    BEEKEEPER_MCP_ENTRYPOINT: "/tmp/adapter.py",
    BEEKEEPER_DATABASE_URL: "sqlite:////tmp/beekeeper.db",
    BEEKEEPER_MCP_MAX_PAGE_SIZE: "0",
    BEEKEEPER_MCP_TIMEOUT_MS: "not-a-number"
  }, "/repo")!;

  assert.equal(config.root, root);
  assert.equal(config.pythonCommand, `${root}/venv/bin/python`);
  assert.equal(config.entryPoint, "/tmp/adapter.py");
  assert.equal(config.databaseUrl, "sqlite:////tmp/beekeeper.db");
  assert.equal(config.maxPageSize, 50);
  assert.equal(config.requestTimeoutMs, 15_000);
});

test("Beekeeper MCP config rejects relative root, python, and entry point paths", () => {
  assert.throws(
    () => loadBeekeeperConfig({ BEEKEEPER_MCP_ENABLED: "1", BEEKEEPER_ROOT: "relative" }, "/repo"),
    /BEEKEEPER_ROOT/
  );
  assert.throws(
    () => loadBeekeeperConfig({ BEEKEEPER_MCP_ENABLED: "1", BEEKEEPER_MCP_PYTHON: "python" }, "/repo"),
    /BEEKEEPER_MCP_PYTHON/
  );
  assert.throws(
    () => loadBeekeeperConfig({ BEEKEEPER_MCP_ENABLED: "1", BEEKEEPER_MCP_ENTRYPOINT: "adapter.py" }, "/repo"),
    /BEEKEEPER_MCP_ENTRYPOINT/
  );
});

test("Beekeeper MCP child environment passes only required settings and no host secrets", () => {
  const config = loadBeekeeperConfig({
    BEEKEEPER_MCP_ENABLED: "1",
    BEEKEEPER_ROOT: "/opt/beekeeper",
    BEEKEEPER_DATABASE_URL: "sqlite:////tmp/beekeeper.db",
    BEEKEEPER_MCP_MAX_PAGE_SIZE: "25",
    BEEKEEPER_MCP_TIMEOUT_MS: "9000"
  }, "/repo")!;

  const child = beekeeperChildEnvironment(config, {
    PATH: "/bin",
    HOME: "/secret",
    NODE_OPTIONS: "--inspect",
    PYTHONPATH: "/host/python",
    API_KEY: "host-secret"
  });

  assert.equal(child.PATH, "/bin");
  assert.equal(child.HOME, undefined);
  assert.equal(child.NODE_OPTIONS, undefined);
  assert.equal(child.API_KEY, undefined);
  assert.equal(child.PYTHONPATH, "/opt/beekeeper");
  assert.equal(child.BEEKEEPER_ROOT, "/opt/beekeeper");
  assert.equal(child.BEEKEEPER_DATABASE_URL, "sqlite:////tmp/beekeeper.db");
  assert.equal(child.BEEKEEPER_MCP_MAX_PAGE_SIZE, "25");
  assert.equal(child.BEEKEEPER_MCP_TIMEOUT_MS, "9000");
});
