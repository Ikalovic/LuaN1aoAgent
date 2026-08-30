# Connectivity Traffic Permission Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Connections API usable when Gateway network-observation files are created by container root, while preserving restrictive permissions for captured HTTP bodies.

**Architecture:** Correct the producer so new `.net.jsonl` metadata files are host-readable, while `.mitm` flow files remain private. Add a per-file defensive boundary in the Web connectivity reader so one unreadable or concurrently removed legacy observation does not fail the complete response.

**Tech Stack:** Python 3 `unittest`, Node.js 22, TypeScript, Node test runner, Docker

---

## File Map

- Modify `network-image/index_server.py`: assign suffix-specific modes when an epoch begins.
- Modify `network-image/test_index_server.py`: verify network metadata and flow-body modes.
- Modify `src/web-server.ts`: skip individual network-observation files that cannot be opened or streamed.
- Modify `test/web-server-connectivity.test.ts`: prove readable observations survive an unreadable sibling path.

### Task 1: Correct Gateway Epoch File Modes

**Files:**
- Modify: `network-image/test_index_server.py`
- Modify: `network-image/index_server.py:530-545`

- [ ] **Step 1: Add the failing network-image test**

Add a test that creates a `GatewayControl`, begins an epoch, and checks both output modes:

```python
def test_gateway_epoch_files_expose_only_network_metadata(self) -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        flow_file = root / "epoch.mitm"
        net_file = root / "epoch.net.jsonl"
        control = GatewayControl(
            str(root / "gateway.sock"), MagicMock(), root / "epoch.json", root, root / "routes.json"
        )

        control.begin_epoch({
            "epochRef": "epoch:test",
            "flowFile": str(flow_file),
            "netFile": str(net_file),
        })

        self.assertEqual(stat.S_IMODE(flow_file.stat().st_mode), 0o660)
        self.assertEqual(stat.S_IMODE(net_file.stat().st_mode), 0o644)
```

Import `stat` from the Python standard library.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
python3 -m unittest network-image/test_index_server.py
```

Expected: failure because the network file is currently `0660`, not `0644`.

- [ ] **Step 3: Apply suffix-specific file modes**

Replace the shared `0660` loop in `GatewayControl.begin_epoch` with explicit modes:

```python
for path, mode in ((flow_file, 0o660), (net_file, 0o644)):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    os.chmod(path, mode)
```

- [ ] **Step 4: Run the test and verify GREEN**

Run `python3 -m unittest network-image/test_index_server.py` and require all tests to pass.

- [ ] **Step 5: Commit the producer fix**

```bash
git add network-image/index_server.py network-image/test_index_server.py
git commit -m "fix: expose gateway network metadata to host"
```

### Task 2: Degrade Individual Unreadable Observations

**Files:**
- Modify: `test/web-server-connectivity.test.ts`
- Modify: `src/web-server.ts:801-824`

- [ ] **Step 1: Add the failing Web regression test**

After the existing connection aggregation test, add a test that places a readable observation beside an unreadable `.net.jsonl` directory. A directory with the matching suffix provides a deterministic cross-user `EISDIR` stream failure without depending on the test runner being non-root:

```ts
test("connections skip one unreadable network observation", async () => {
  const trafficDir = join(fixture.runtimeDir, "traffic", "flows", "task-unreadable");
  await mkdir(trafficDir, { recursive: true });
  await writeFile(join(trafficDir, "readable.net.jsonl"), `${JSON.stringify({
    kind: "network_connection",
    network_ref: "net:readable",
    event: "new",
    protocol: "tcp",
    source: { host: "127.0.0.1", port: 40100 },
    destination: { host: "127.0.0.1", port: 8080 },
    observed_at: "2026-08-31T00:00:00Z"
  })}\n`);
  await mkdir(join(trafficDir, "unreadable.net.jsonl"));

  const response = await authenticatedGet(fixture.analystCookie, "/api/connectivity");

  assert.equal(response.status, 200);
  const connections = (await json(response)).connections as Array<Record<string, unknown>>;
  assert(connections.some((item) => item.externalId === "net:readable"));
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm run build:server
node --test --test-name-pattern="connections skip one unreadable" dist/test/web-server-connectivity.test.js
```

Expected: HTTP 500 because the stream error currently escapes `readNetworkConnections`.

- [ ] **Step 3: Add a per-file read boundary**

Move one file's JSONL processing into a helper and return no records when opening or streaming fails:

```ts
async function readNetworkConnectionFile(file: string): Promise<JsonRecord[]> {
  const records: JsonRecord[] = [];
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        records.push(JSON.parse(line) as JsonRecord);
      } catch {
        // Ignore a malformed observation line without losing the remaining file.
      }
    }
  } catch {
    return [];
  }
  return records;
}
```

Have `readNetworkConnections` iterate over the returned records and retain its latest-record selection logic.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the focused build and test command from Step 2. Require the regression test to pass.

- [ ] **Step 5: Run the complete connectivity contract suite**

```bash
node --test dist/test/web-server-connectivity.test.js
```

Expected: all connectivity tests pass.

- [ ] **Step 6: Commit the consumer defense**

```bash
git add src/web-server.ts test/web-server-connectivity.test.ts
git commit -m "fix: tolerate unreadable network observations"
```

### Task 3: Full Verification And Runtime Recovery

**Files:**
- No tracked source changes expected.

- [ ] **Step 1: Run source verification**

```bash
python3 -m unittest discover -s network-image -p 'test_*.py'
npm run build
npm run test:web
node --test dist/test/web-server-connectivity.test.js
git diff --check
```

Expected: all commands exit zero. The existing Vite chunk-size warning is informational.

- [ ] **Step 2: Merge the verified branch into `main`**

Fast-forward `main` after confirming the known untracked Beekeeper plan remains untouched. Rerun the focused producer and connectivity tests on the merged result.

- [ ] **Step 3: Rebuild the network image**

Use the repository's existing network-image build command discovered from `package.json`, scripts, or documentation. Verify `luanniao-network:latest` has a new image creation time and contains the `0644` mode behavior.

- [ ] **Step 4: Repair existing network metadata only**

Change only regular `*.net.jsonl` and segmented `*.net.jsonl.*` observation files under `.agent-runtime/sessions/*/traffic/flows` to be readable by the host. Do not change `.mitm`, CA keys, credentials, artifacts, or SQLite files.

- [ ] **Step 5: Restart and verify the panel**

Restart `luaniao-web` on port 8787. Verify the process remains alive, `/` returns HTTP 200 with proxy bypass, and an authenticated `/api/connectivity` request for the previously failing Runtime returns HTTP 200.

- [ ] **Step 6: Push the merged result**

Push `main` to `origin`, verify `origin/main` matches local `HEAD`, and report the repaired runtime file count plus test evidence.
