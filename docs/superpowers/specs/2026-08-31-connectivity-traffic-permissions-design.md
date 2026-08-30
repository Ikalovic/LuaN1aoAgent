# Connectivity Traffic Permission Fix

## Problem

The Web server runs as the host user, while the Gateway container runs as root. At the start of an epoch, the Gateway creates `.net.jsonl` network-observation files as `root:root` with mode `0660`. The Connections API reads those files directly from the host, so one newly-created file can raise `EACCES` and turn the complete `/api/connectivity` response into HTTP 500.

## Design

Use two narrowly scoped protections:

1. The Gateway creates `.net.jsonl` files with mode `0644`, because they contain connection metadata consumed by the host Web server. `.mitm` files retain mode `0660`; this change does not make captured HTTP bodies broadly readable.
2. The Connections API treats an unreadable or concurrently removed individual `.net.jsonl` file as an unavailable observation and continues reading the remaining files. Connectivity definitions from SQLite and readable observations remain visible instead of failing the complete page.

Existing affected `.net.jsonl` files in the active runtime will receive host-readable permissions after the code is verified. The network image will then be rebuilt so future epochs use the corrected mode.

## Error Handling

Only per-file filesystem failures while opening or streaming a network-observation file are degraded. JSON parse errors remain ignored as before. Runtime path validation, database failures, authorization errors, and unrelated API errors retain their current behavior.

The defensive reader does not modify files and does not synthesize connection records. Skipped files simply contribute no observations until their permissions are repaired.

## Tests

- A network-image unit test verifies that epoch creation sets `.net.jsonl` to `0644` while `.mitm` remains `0660`.
- A Web connectivity regression test creates one readable observation file and one unreadable observation path, then verifies `/api/connectivity` still returns HTTP 200 and includes the readable observation.
- Existing network-image, connectivity API, build, and Web tests must continue to pass.
- Runtime verification checks the active `.net.jsonl` is readable by the Web process and the authenticated Connections API no longer returns HTTP 500.

## Non-Goals

- Changing Gateway container ownership or introducing host UID/GID mapping.
- Relaxing `.mitm`, credential, certificate-key, or artifact permissions.
- Redesigning the Connections page or connectivity storage model.
