if (process.env.FOFA_LIVE_TEST !== "1") {
  console.error("FOFA live smoke is disabled; set FOFA_LIVE_TEST=1 explicitly");
  process.exitCode = 2;
} else if (!process.env.FOFA_API_KEY) {
  console.error("FOFA_API_KEY is required for the live smoke test");
  process.exitCode = 2;
} else {
  try {
    const { FofaClient } = await import("../dist/src/fofa/fofa-client.js");
    const { loadFofaConfig } = await import("../dist/src/fofa/fofa-config.js");
    const config = loadFofaConfig(process.env);
    if (!config) throw new Error("not configured");
    const client = new FofaClient({ ...config, maxResultsPerCall: 1, maxResultsPerTask: 1 });
    const result = await client.search({
      query: 'domain="fofa.info"',
      fields: ["host", "ip", "port"],
      size: 1,
      full: false
    });
    console.log(JSON.stringify({ ok: true, returned: result.results.length }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error && typeof error === "object" && "code" in error ? error.code : "fofa_provider_error"
    }));
    process.exitCode = 1;
  }
}
