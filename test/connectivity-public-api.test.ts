import assert from "node:assert/strict";
import test from "node:test";
import * as publicApi from "../src/index.js";

test("public API exposes ConnectivityRuntime without legacy lifecycle owners", () => {
  assert.equal(typeof publicApi.ConnectivityRuntime, "function");
  assert.equal("ConnectivitySupervisor" in publicApi, false);
  assert.equal("ConnectivitySupervisorRegistry" in publicApi, false);
  assert.equal("SessionBroker" in publicApi, false);
  assert.equal("TunnelManager" in publicApi, false);
  assert.equal("ChiselAdapter" in publicApi, false);
  assert.equal("NodeProcessDriver" in publicApi, false);
  assert.equal("OperationalTopology" in publicApi, false);
});
