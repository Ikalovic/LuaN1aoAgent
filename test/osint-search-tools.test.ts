import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeBingWrapper,
  distinctiveTokens,
  extractSiteConstraint,
  hostMatchesDomain,
  normalizeUrl,
  searchOsint,
  type OsintFetch,
  type OsintResult,
  type OsintSourceCoverage
} from "../src/tools/osint-search-tools.js";

/**
 * Fixtures are real SERP responses captured live from each engine. They are the
 * whole point of this suite: the defects being guarded against (Bing ignoring
 * `site:`, Sogou exposing only a session-bound wrapper, 360 hiding the real URL
 * in `data-mdurl`) are only visible in genuine markup, not in synthetic HTML.
 */
const FIXTURES: Record<string, string> = {
  sogouSiteExample: "sogou-site-example.html",
  sogouCnQuery: "sogou-cn-query.html",
  so360SiteExample: "so360-site-example.html",
  so360CnQuery: "so360-cn-query.html",
  bingSiteExample: "bing-site-example.html"
};

const fixtureCache = new Map<string, string>();

function fixture(name: string): string {
  const file = FIXTURES[name];
  assert.ok(file, `unknown fixture ${name}`);
  const cached = fixtureCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const body = readFileSync(join(process.cwd(), "test", "fixtures", "osint", file), "utf8");
  fixtureCache.set(file, body);
  return body;
}

type SearchOutcome = {
  success: boolean;
  resultClass: string;
  negativeSignalStrength: string;
  queries: string[];
  sourceCoverage: Record<string, OsintSourceCoverage>;
  results: OsintResult[];
  droppedCounts: Record<string, number>;
  evidenceSummary: string;
  recommendedNextSteps: string[];
};

/** Routes each engine to its recorded response; no test touches the network. */
function stubFetch(
  responses: Partial<Record<"sogou" | "so360" | "bing", string>>,
  overrides: Partial<Record<"sogou" | "so360" | "bing", Response>> = {},
  onRequest?: (url: string) => void
): OsintFetch {
  const engineOf = (url: string): "sogou" | "so360" | "bing" | undefined => {
    if (url.includes("sogou.com")) return "sogou";
    if (url.includes("so.com")) return "so360";
    if (url.includes("bing.com")) return "bing";
    return undefined;
  };
  return async (input) => {
    const url = String(input);
    onRequest?.(url);
    const engine = engineOf(url);
    assert.ok(engine, `unexpected request in test: ${url}`);
    const override = overrides[engine];
    if (override) {
      return override;
    }
    const body = responses[engine];
    assert.ok(body !== undefined, `no stubbed response for ${engine}`);
    return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

function urlsOf(results: OsintResult[]): string[] {
  return results.map((item) => item.url).sort();
}

test("a site: query rejects results from engines that ignore the operator", async () => {
  // Bing answers `site:example.com contact` with dictionary pages about the word
  // "contact" — ten well-formed results, none on example.com. This is the failure
  // mode that made a separate tool necessary: the raw transport looks healthy.
  const outcome = await searchOsint(
    { queries: ["site:example.com contact"], engines: ["bing"] },
    { fetch: stubFetch({ bing: fixture("bingSiteExample") }) }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.results.length, 0, "off-domain results must not survive");
  assert.equal(outcome.sourceCoverage.bing.status, "operator_unsupported");
  assert.match(outcome.sourceCoverage.bing.reason ?? "", /site: operator/);
  assert.equal(outcome.sourceCoverage.bing.hits, 10, "raw hit count still reports what the engine sent");
  assert.equal(outcome.sourceCoverage.bing.kept, 0);
  assert.equal(outcome.droppedCounts["bing:site_mismatch"], 10);
  assert.equal(outcome.resultClass, "no_public_hit");
  assert.match(outcome.evidenceSummary, /discarded by site: compliance/);
});

test("Sogou and 360 honour site: and yield on-target results", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"], engines: ["sogou", "so360"] },
    {
      fetch: stubFetch({
        sogou: fixture("sogouSiteExample"),
        so360: fixture("so360SiteExample")
      })
    }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.resultClass, "direct_hit");
  assert.ok(outcome.results.length >= 2);
  assert.ok(outcome.results.every((item) => item.relevance === "site_match"));
  assert.ok(outcome.results.every((item) => hostMatchesDomain(new URL(item.url).hostname, "example.com")));
  assert.equal(outcome.sourceCoverage.sogou.status, "ok");
  assert.equal(outcome.sourceCoverage.so360.status, "ok");
  assert.equal(outcome.negativeSignalStrength, "none");
});

test("360's data-mdurl is used rather than the session-bound wrapper", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"], engines: ["so360"] },
    { fetch: stubFetch({ so360: fixture("so360SiteExample") }) }
  ) as unknown as SearchOutcome;

  assert.deepEqual(urlsOf(outcome.results), ["https://example.com/", "https://example.com/index.html"]);
  assert.ok(
    outcome.results.every((item) => !item.url.includes("so.com/link")),
    "the /link?m= wrapper 400s without cookies and must not leak into results"
  );
});

test("identical URLs from different engines collapse to one result", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"], engines: ["sogou", "so360"] },
    {
      fetch: stubFetch({
        sogou: fixture("sogouSiteExample"),
        so360: fixture("so360SiteExample")
      })
    }
  ) as unknown as SearchOutcome;

  // Sogou cites `http://example.com`, 360 cites `https://example.com/`; after
  // normalisation they are the same destination and must be reported once.
  const rootHits = outcome.results.filter((item) => normalizeUrl(item.url) === "example.com");
  assert.equal(rootHits.length, 1);
});

test("a query whose terms appear nowhere is reported as irrelevant, not as hits", async () => {
  // The Bing fixture holds English dictionary pages about "contact"; a Chinese
  // query has no term in common with them.
  const outcome = await searchOsint(
    { queries: ["香农熵 定义"], engines: ["bing"] },
    { fetch: stubFetch({ bing: fixture("bingSiteExample") }) }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.results.length, 0);
  assert.equal(outcome.sourceCoverage.bing.status, "irrelevant");
  assert.equal(outcome.droppedCounts["bing:irrelevant"], 10);
  assert.equal(outcome.resultClass, "no_public_hit");
  assert.equal(outcome.negativeSignalStrength, "weak");
});

test("a genuine no-result response is negative evidence", async () => {
  const outcome = await searchOsint(
    { queries: ["site:nonexistent-target.example"] },
    {
      fetch: stubFetch({}, {
        sogou: new Response("<html><body>no results</body></html>", { status: 200 }),
        so360: new Response("<html><body>no results</body></html>", { status: 200 })
      })
    }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.resultClass, "no_public_hit");
  assert.equal(outcome.negativeSignalStrength, "weak");
  assert.equal(outcome.sourceCoverage.sogou.status, "no_results");
  assert.equal(outcome.sourceCoverage.so360.status, "no_results");
  assert.equal(outcome.success, true);
});

test("every source failing is source_failure, never a negative finding", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"] },
    {
      fetch: stubFetch({}, {
        sogou: new Response("upstream boom", { status: 500 }),
        so360: new Response("upstream boom", { status: 503 }),
        bing: new Response("upstream boom", { status: 502 })
      })
    }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.resultClass, "source_failure");
  assert.equal(outcome.success, false);
  assert.equal(outcome.negativeSignalStrength, "none");
  assert.equal(outcome.sourceCoverage.sogou.status, "error");
  assert.match(outcome.recommendedNextSteps.join(" "), /every source failed/);
});

test("an anti-bot page is blocked, not empty", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"], engines: ["sogou"] },
    {
      fetch: stubFetch({}, {
        sogou: new Response("<html><body>百度安全验证 请输入验证码</body></html>", { status: 200 })
      })
    }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.sourceCoverage.sogou.status, "blocked");
  assert.equal(outcome.resultClass, "source_failure");
});

test("a network failure is an error and is not counted as absence", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"], engines: ["so360"] },
    {
      fetch: async () => {
        throw new TypeError("fetch failed");
      }
    }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.sourceCoverage.so360.status, "error");
  assert.match(outcome.sourceCoverage.so360.reason ?? "", /fetch failed/);
  assert.equal(outcome.resultClass, "source_failure");
});

test("results are capped per engine without dropping the smaller engine", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"], maxResults: 1, engines: ["so360"] },
    { fetch: stubFetch({ so360: fixture("so360SiteExample") }) }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.results.length, 1);
});

test("duplicate, unusable and over-cap queries are normalised before any request", async () => {
  const seen: string[] = [];
  await searchOsint(
    {
      queries: [
        "site:example.com",
        "site:example.com",
        "   ",
        "a",
        "site:example.com contact",
        "site:example.com whois",
        "site:example.com ftp",
        "site:example.com mail",
        "site:example.com smtp",
        "site:example.com vpn"
      ],
      engines: ["sogou"]
    },
    {
      fetch: stubFetch({ sogou: fixture("sogouSiteExample") }, {}, (url) => seen.push(url))
    }
  );

  assert.equal(seen.length, 6, "the per-call query cap must bound outbound requests");
});

test("query normalisation keeps order and drops duplicates and unusable entries", async () => {
  const outcome = await searchOsint(
    { queries: ["  site:example.com  ", "site:example.com", "a", "  ", "site:example.com whois"], engines: ["sogou"] },
    { fetch: stubFetch({ sogou: fixture("sogouSiteExample") }) }
  ) as unknown as SearchOutcome;

  assert.deepEqual(outcome.queries, ["site:example.com", "site:example.com whois"]);
});

test("the engine's own verticals are not reported as findings", async () => {
  // The 360 SERP for this query carries its own video/image/AI verticals
  // (tv.360kan.com, image.so.com, ai.so.com) in the same containers as organic
  // results. They are navigation, not evidence about the target.
  const outcome = await searchOsint(
    { queries: ["香农熵"], engines: ["so360"] },
    { fetch: stubFetch({ so360: fixture("so360CnQuery") }) }
  ) as unknown as SearchOutcome;

  assert.ok(outcome.results.length > 0, "organic results must survive the filter");
  assert.ok(
    outcome.results.every((item) => {
      const host = new URL(item.url).hostname;
      return !["so.com", "360kan.com", "360.com", "360.cn"].some((d) => hostMatchesDomain(host, d));
    }),
    `engine properties leaked into results: ${urlsOf(outcome.results).join(", ")}`
  );
  assert.ok(outcome.results.some((item) => hostMatchesDomain(new URL(item.url).hostname, "csdn.net")));
  assert.ok(
    Object.keys(outcome.droppedCounts).some((key) => key.endsWith(":engine_property")),
    "the drop must be reported rather than silently swallowed"
  );
});

test("an unknown engine selection fails loudly instead of silently returning nothing", async () => {
  const outcome = await searchOsint(
    { queries: ["site:example.com"], engines: [] },
    { fetch: stubFetch({}) }
  ) as unknown as SearchOutcome;

  assert.equal(outcome.success, false);
  assert.equal(outcome.resultClass, "source_failure");
  assert.equal(outcome.results.length, 0);
});

test("Bing's base64 ck/a wrapper decodes to the real destination", () => {
  // Captured live; the wrapper is what Bing returns on some edges and what made
  // search-result URLs useless for both fetching and cross-round de-duplication.
  const wrapper =
    "https://www.bing.com/ck/a?!&&p=dce8d537a975e4ba4baf3465bba50154fe2a8f714bd366376e02efdc99e2dad8" +
    "JmltdHM9MTc4OTUxNjgwMA&ptn=3&ver=2&hsh=4&fclid=12e2b972-bb29-66a0-3142-aea5ba6167a4" +
    "&u=a1aHR0cHM6Ly93d3cuaW1hdHJhbmt5bHB5bGEuZmkva3lscHlsYWxvbWF0&ntb=1";

  assert.equal(decodeBingWrapper(wrapper), "https://www.imatrankylpyla.fi/kylpylalomat");
  assert.equal(decodeBingWrapper("https://example.com/plain"), "https://example.com/plain");
});

test("site: extraction handles the operator forms seen in real queries", () => {
  assert.equal(extractSiteConstraint("site:example.com contact"), "example.com");
  assert.equal(extractSiteConstraint("site:*.example.com"), "example.com");
  assert.equal(extractSiteConstraint("foo site:sub.example.co.uk bar"), "sub.example.co.uk");
  assert.equal(extractSiteConstraint("site:notadomain"), undefined);
  assert.equal(extractSiteConstraint("example.com contact"), undefined);
});

test("domain matching is dot-anchored so lookalikes are excluded", () => {
  assert.equal(hostMatchesDomain("example.com", "example.com"), true);
  assert.equal(hostMatchesDomain("www.example.com", "example.com"), true);
  assert.equal(hostMatchesDomain("a.b.example.com", "example.com"), true);
  assert.equal(hostMatchesDomain("notexample.com", "example.com"), false);
  assert.equal(hostMatchesDomain("example.com.evil.net", "example.com"), false);
  assert.equal(hostMatchesDomain("", "example.com"), false);
});

test("distinctive tokens drop operators, discourse words and keep identity terms", () => {
  assert.deepEqual(distinctiveTokens("site:example.com contact"), ["contact"]);
  // 定义 is a discourse word: keeping it let an incense article match a query
  // about Shannon entropy, observed live.
  assert.deepEqual(distinctiveTokens("香农熵 定义"), ["香农熵"]);
  assert.deepEqual(distinctiveTokens("site:example.com filetype:pdf"), []);
  assert.ok(distinctiveTokens("ACME Corporation").includes("acme"));
  // Contact nouns are pivots, not discourse, and must survive.
  assert.deepEqual(distinctiveTokens("某某科技 联系电话"), ["某某科技", "联系电话"]);
});

test("URL normalisation strips tracking parameters and casing for de-duplication", () => {
  assert.equal(normalizeUrl("https://WWW.Example.com/a/?utm_source=x&id=2#frag"), "example.com/a?id=2");
  assert.equal(normalizeUrl("https://example.com/"), "example.com");
  assert.equal(normalizeUrl("http://example.com"), "example.com");
  assert.equal(normalizeUrl("mailto:someone@example.com"), undefined);
  assert.equal(normalizeUrl("not a url"), undefined);
});
