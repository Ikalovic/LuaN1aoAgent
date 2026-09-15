import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EnvConfigInputError, EnvConfigStore, isSensitiveKey } from "../src/env-config-store.js";

async function withProject(run: (project: string) => Promise<void>): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "env-config-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test("view parses the .env file and masks sensitive values", async () => {
  await withProject(async (project) => {
    const envPath = join(project, ".env");
    await writeFile(envPath, [
      "# LLM configuration",
      "LLM_API_KEY=sk-abcdefgh1234",
      "FOFA_EMAIL=ops@example.com",
      "BEEKEEPER_MCP_ENABLED=1",
      "FOFA_API_KEY=\"quotedkey1234567\"",
      "EMPTY=",
      "not an assignment"
    ].join("\n"));
    const store = new EnvConfigStore({ cwd: project, environment: {} });

    const view = store.view();
    assert.equal(view.path, envPath);
    assert.ok(view.updatedAt);
    assert.deepEqual(view.entries.map((entry) => entry.key), [
      "LLM_API_KEY",
      "FOFA_EMAIL",
      "BEEKEEPER_MCP_ENABLED",
      "FOFA_API_KEY",
      "EMPTY"
    ]);
    const byKey = new Map(view.entries.map((entry) => [entry.key, entry]));
    assert.deepEqual(byKey.get("LLM_API_KEY"), { key: "LLM_API_KEY", sensitive: true, preview: "••••1234" });
    assert.deepEqual(byKey.get("FOFA_API_KEY"), { key: "FOFA_API_KEY", sensitive: true, preview: "••••4567" });
    assert.deepEqual(byKey.get("FOFA_EMAIL"), { key: "FOFA_EMAIL", sensitive: false, value: "ops@example.com" });
    assert.deepEqual(byKey.get("BEEKEEPER_MCP_ENABLED"), { key: "BEEKEEPER_MCP_ENABLED", sensitive: false, value: "1" });
    assert.deepEqual(byKey.get("EMPTY"), { key: "EMPTY", sensitive: false, value: "" });
  });
});

test("view tolerates a missing .env file", async () => {
  await withProject(async (project) => {
    const store = new EnvConfigStore({ cwd: project, environment: {} });
    const view = store.view();
    assert.deepEqual(view.entries, []);
    assert.equal(view.updatedAt, null);
  });
});

test("applyChanges rewrites entries, appends new keys, keeps comments, and syncs the environment", async () => {
  await withProject(async (project) => {
    const envPath = join(project, ".env");
    await writeFile(envPath, "A=1\n# keep me\nB=old\n");
    const environment: NodeJS.ProcessEnv = { B: "old", UNTOUCHED: "1" };
    const store = new EnvConfigStore({ cwd: project, environment });

    const view = store.applyChanges({ set: { A: "2", C: "3" }, remove: ["B"] });

    assert.equal(await readFile(envPath, "utf8"), "A=2\n# keep me\nC=3\n");
    assert.deepEqual(environment, { A: "2", C: "3", UNTOUCHED: "1" });
    assert.deepEqual(view.entries, [
      { key: "A", sensitive: false, value: "2" },
      { key: "C", sensitive: false, value: "3" }
    ]);
  });
});

test("applyChanges preserves CRLF line endings", async () => {
  await withProject(async (project) => {
    const envPath = join(project, ".env");
    await writeFile(envPath, "A=1\r\nB=2\r\n");
    const store = new EnvConfigStore({ cwd: project, environment: {} });

    store.applyChanges({ set: { A: "9" } });

    assert.equal(await readFile(envPath, "utf8"), "A=9\r\nB=2\r\n");
  });
});

test("applyChanges round-trips quoted and hash-containing values", async () => {
  await withProject(async (project) => {
    const store = new EnvConfigStore({ cwd: project, environment: {} });

    store.applyChanges({ set: { QUOTED: "'ring'", HASH: "a#b" } });
    const view = store.view();
    const byKey = new Map(view.entries.map((entry) => [entry.key, entry]));

    assert.equal(byKey.get("QUOTED")?.value, "'ring'");
    assert.equal(byKey.get("HASH")?.value, "a#b");
    assert.equal(await readFile(join(project, ".env"), "utf8"), "QUOTED=\"'ring'\"\nHASH=\"a#b\"\n");
  });
});

test("applyChanges creates the file atomically with restrictive permissions", async () => {
  await withProject(async (project) => {
    const envPath = join(project, ".env");
    const store = new EnvConfigStore({ cwd: project, environment: {} });

    store.applyChanges({ set: { FOFA_API_KEY: "abcdefgh1234" } });

    assert.equal(await readFile(envPath, "utf8"), "FOFA_API_KEY=abcdefgh1234\n");
    if (process.platform !== "win32") {
      assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    }
  });
});

test("applyChanges rejects invalid input", async () => {
  await withProject(async (project) => {
    const store = new EnvConfigStore({ cwd: project, environment: {} });

    const invalid: Array<() => void> = [
      () => store.applyChanges({ set: { "1BAD": "x" } }),
      () => store.applyChanges({ set: { "BAD KEY": "x" } }),
      () => store.applyChanges({ set: { PATH: "/tmp/evil" } }),
      () => store.applyChanges({ set: { EMPTY: "   " } }),
      () => store.applyChanges({ set: { MULTI: "a\nb" } }),
      () => store.applyChanges({ set: { BOTH: "x" }, remove: ["BOTH"] }),
      () => store.applyChanges({ set: { LONG: "x".repeat(5000) } }),
      () => store.applyChanges({ remove: "FOO" as unknown as string[] }),
      () => store.applyChanges({ set: { NUM: 7 as unknown as string } })
    ];
    for (const attempt of invalid) {
      assert.throws(attempt, EnvConfigInputError);
    }
  });
});

test("isSensitiveKey classifies credential-style names", () => {
  for (const key of ["LLM_API_KEY", "FOFA_API_KEY", "BRAVE_SEARCH_API_KEY", "NVD_API_KEY", "BEEKEEPER_DATABASE_URL", "MY_TOKEN", "DB_PASSWORD"]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ["FOFA_EMAIL", "FOFA_PROVIDER", "BEEKEEPER_MCP_ENABLED", "BEEKEEPER_ROOT", "FOFA_API_BASE_URL"]) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});
