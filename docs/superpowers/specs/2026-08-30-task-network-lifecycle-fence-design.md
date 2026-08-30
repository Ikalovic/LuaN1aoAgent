# Task Network Lifecycle Fence Design

## Problem

When a Task submits a retryable blocked outcome, Planner may reopen the same
Task before the previous epoch's asynchronous network finalization and resource
cleanup complete. The old cleanup can then observe or remove resources already
adopted by the new epoch. This produces gateway epoch mismatches, active network
endpoint removal failures, and an Executor whose default route and DNS address
point at a removed Gateway.

## Design

Controller will serialize the complete Executor resource lifecycle by `taskId`.
Preparing a new epoch must wait for any prior finalization and terminal cleanup
for that Task. Terminal cleanup will be registered as part of the same lifecycle
fence before the completed execution is exposed to Planner for rescheduling.

Cleanup will retain identity checks: an older cleanup operation may remove only
the Sandbox instance it captured. It must not delete a newer Sandbox mapping.
Connectivity cleanup runs before the lifecycle fence resolves, so a subsequent
`beginTaskEpoch` cannot race an older `disposeTask`.

Planner retry semantics remain unchanged. A retryable blocked Task may still be
reopened, but its next epoch starts only after the previous epoch has fully
released its network resources.

## Error Handling

Cleanup remains best-effort for task outcome reporting and continues to emit
`executor_task_cleanup_failed` when Docker cleanup fails. The lifecycle fence
must always settle, including after cleanup errors, so one failed cleanup does
not permanently deadlock the Task. A subsequent start may then use the existing
network reconciliation logic.

## Tests

Add a controller regression test that holds old-epoch cleanup open, makes the
same Task eligible for another epoch, and verifies that new sandbox preparation
does not begin until cleanup settles. Also verify that cleanup failure releases
the fence and that existing network finalization tests continue to pass.

## Non-Goals

- Changing Planner decisions or retry budgets.
- Relaxing authorized Scope enforcement.
- Treating out-of-scope public hosts as connectivity controls.
- Refactoring Docker network or Gateway internals.
