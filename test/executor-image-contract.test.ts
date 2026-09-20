import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The executor image is the whole tool surface the Executor gets, and the
 * `io.luanniao.executor.facts` label is what agents are told about it. These
 * checks keep the Dockerfile, the label and the shipped wordlists from drifting
 * apart without needing a Docker daemon.
 */

const IMAGE_DIR = join(process.cwd(), "executor-image");
const dockerfile = readFileSync(join(IMAGE_DIR, "Dockerfile"), "utf8");

function labelFacts(): { version: number; uid: number; rawSockets: boolean; tools: string[]; wordlists: string[] } {
  const match = /LABEL io\.luanniao\.executor\.facts='([^']*)'/.exec(dockerfile);
  assert.ok(match, "the Dockerfile must declare the executor facts label");
  return JSON.parse(match[1]!);
}

function assertedTools(): string[] {
  const match = /for t in ([^;]*); do/.exec(dockerfile);
  assert.ok(match, "the Dockerfile must assert the advertised tools exist");
  return match[1]!.replace(/\\/g, " ").split(/\s+/).filter(Boolean);
}

function installedPackages(): string[] {
  const match = /apt-get install -y --no-install-recommends([\s\S]*?)&& rm -rf/.exec(dockerfile);
  assert.ok(match, "the Dockerfile must install a package list");
  return match[1]!
    .split("\n")
    .map((line) => line.replace(/\\$/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
}

test("the facts label describes a sandbox-shaped image", () => {
  const facts = labelFacts();
  assert.equal(facts.version, 2);
  assert.equal(facts.uid, 1000);
  assert.equal(facts.rawSockets, false);
  assert.ok(facts.tools.length > 0, "the label must advertise tools");
  assert.equal(new Set(facts.tools).size, facts.tools.length, "advertised tools must be unique");
  for (const tool of facts.tools) {
    assert.match(tool, /^[a-z0-9][a-z0-9._+-]*$/, `${tool} is not a command name`);
  }
  assert.ok(facts.wordlists.length > 0, "the label must advertise the shipped wordlists");
});

test("every advertised tool is asserted at build time, and nothing more", () => {
  const advertised = [...labelFacts().tools].sort();
  const asserted = [...new Set(assertedTools())].sort();
  assert.deepEqual(
    asserted,
    advertised,
    "the build-time `command -v` loop and the facts label must list the same tools, or the image can ship a tool it does not have"
  );
  // The assertion has to be able to fail the build, not merely print.
  assert.match(dockerfile, /command -v "\$t"[\s\S]{0,120}exit 1/);
});

test("hashcat ships with the OpenCL pieces it cannot run without", () => {
  // Measured: hashcat without an ICD loader exits with "You are probably missing
  // the CUDA, HIP or OpenCL runtime installation", and without pocl there is no
  // CPU device at all. Installing hashcat alone produces a dead tool.
  if (!labelFacts().tools.includes("hashcat")) return;
  const packages = installedPackages();
  for (const required of ["hashcat", "ocl-icd-libopencl1", "pocl-opencl-icd"]) {
    assert.ok(packages.includes(required), `${required} must be installed for hashcat to work`);
  }
});

test("the agent user's home is the writable task workspace", () => {
  // Measured: hashcat resolves its session directory through getpwuid(), not
  // $HOME, so a home under the read-only root filesystem aborts it.
  assert.match(dockerfile, /useradd[^\n]*--home-dir \/workspace\/home/);
  assert.match(dockerfile, /install -d[^\n]*\/workspace\/home/);
});

test("every advertised wordlist is produced by the build", () => {
  for (const path of labelFacts().wordlists) {
    const base = path.split("/").pop()!;
    assert.ok(dockerfile.includes(base), `${base} is advertised but the build never writes it`);
    assert.ok(path.startsWith("/opt/luanniao/wordlists/"), `${path} must live in the image wordlist directory`);
  }
  assert.match(dockerfile, /test -s "\$f"[\s\S]{0,120}exit 1/, "the build must fail on an empty wordlist");
});

/** Tracked wordlist sources, with build-time comment/blank stripping applied. */
function entries(file: string): string[] {
  return readFileSync(join(IMAGE_DIR, "wordlists", file), "utf8")
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line && !line.startsWith("#"));
}

test("the curated wordlists are well formed", () => {
  const files = ["passwords-extra.txt", "usernames-extra.txt", "default-credentials.txt"];
  for (const file of files) {
    const lines = entries(file);
    assert.ok(lines.length > 0, `${file} must contribute entries`);
    for (const line of lines) {
      assert.equal(line, line.trim(), `${file}: "${line}" has surrounding whitespace`);
      assert.ok(!line.includes("\t"), `${file}: "${line}" contains a tab`);
    }
    assert.equal(new Set(lines).size, lines.length, `${file} contains duplicate entries`);
  }

  assert.ok(entries("passwords-extra.txt").length >= 150, "passwords-extra.txt is the curated half of the password list");
  assert.ok(entries("usernames-extra.txt").length >= 40, "usernames-extra.txt is the curated half of the username list");
  for (const line of [...entries("passwords-extra.txt"), ...entries("usernames-extra.txt")]) {
    assert.match(line, /^\S+$/, `"${line}" has an internal space and can never be a candidate`);
  }
});

test("default-credentials.txt stays a hydra -C file", () => {
  const lines = entries("default-credentials.txt");
  for (const line of lines) {
    assert.match(line, /^[^\s:]+:[^\s]*$/, `"${line}" is not a user:pass pair`);
  }
  for (const expected of ["admin:password", "tomcat:s3cret", "guest:guest", "Admin:zabbix"]) {
    assert.ok(lines.includes(expected), `default-credentials.txt is missing ${expected}`);
  }
  assert.ok(
    lines.some((line) => line.endsWith(":")),
    "vendor empty-password defaults (MySQL root, MSSQL sa) must stay expressible"
  );

  // The prose skill must point at the machine-readable file, or the two drift.
  const skill = readFileSync(join(process.cwd(), "templates", "skills", "default-credentials", "SKILL.md"), "utf8");
  assert.ok(skill.includes("/opt/luanniao/wordlists/default-credentials.txt"));
  assert.ok(skill.includes("hydra -C"));
});
