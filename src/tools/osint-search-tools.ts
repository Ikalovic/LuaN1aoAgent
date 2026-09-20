import { defineTool } from "@earendil-works/pi-coding-agent";
import { JSDOM, VirtualConsole } from "jsdom";
import { Type } from "typebox";

/**
 * Strictly passive OSINT search.
 *
 * Every request this module makes goes to a third-party search engine; nothing
 * here ever contacts the target. That is the whole point of the tool: it lets an
 * information-collection Task look at the public internet without originating a
 * packet towards the authorized scope.
 *
 * Three defects in the generic `web_search` path motivated a separate tool, all
 * of them measured against live responses rather than assumed:
 *
 * 1. Bing's scraped SERP ignores the `site:` operator entirely and collapses a
 *    multi-term query into a single-word dictionary lookup, yet still returns
 *    ten well-formed results. `web_search` reports that as `success: true`. For
 *    OSINT a confidently-wrong answer is worse than a failure, so this tool
 *    validates `site:` compliance and drops non-compliant hits.
 * 2. All three engines hand back redirect wrappers instead of real URLs
 *    (`bing.com/ck/a?...&u=a1<base64url>`, `/link?url=...`). Following them
 *    needs a session, so the real URL is taken from the SERP markup instead.
 * 3. "No results" and "the source failed" must not collapse into one signal.
 *    Only `200 + empty` counts as negative evidence.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_QUERIES_PER_CALL = 6;
const MAX_RESULTS_LIMIT = 20;
const DEFAULT_MAX_RESULTS = 8;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

export type OsintFetchInit = RequestInit;
export type OsintFetch = (input: string | URL | Request, init?: OsintFetchInit) => Promise<Response>;

export type OsintToolDependencies = {
  fetch?: OsintFetch;
};

export type OsintEngineId = "sogou" | "so360" | "bing";

export type OsintHit = {
  title: string;
  url: string;
  displayUrl?: string;
  snippet: string;
  flags?: string[];
};

export type OsintResult = {
  title: string;
  url: string;
  displayUrl?: string;
  snippet: string;
  engine: OsintEngineId;
  query: string;
  relevance: "site_match" | "token_match";
  flags?: string[];
};

export type OsintSourceStatus =
  | "ok"
  | "no_results"
  | "operator_unsupported"
  | "irrelevant"
  | "blocked"
  | "error";

export type OsintSourceCoverage = {
  status: OsintSourceStatus;
  /** Raw hits parsed out of the SERP before any filtering. */
  hits: number;
  /** Hits that survived `site:` compliance and the relevance gate. */
  kept: number;
  reason?: string;
};

type EngineSpec = {
  id: OsintEngineId;
  label: string;
  /** The engine's own properties, which surface as results but are not findings. */
  ownDomains: string[];
  buildUrl: (query: string, maxResults: number) => string;
  parse: (html: string, pageUrl: string) => OsintHit[];
};

type QueryOutcome = {
  engine: OsintEngineId;
  query: string;
  outcome: "parsed" | "blocked" | "error";
  hits: OsintHit[];
  error?: string;
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "www", "com", "net", "org", "http", "https", "html", "index"
]);

/**
 * Discourse words that carry no target identity. Without these, a query like
 * "香农熵 定义" would accept any page that happens to use the word 定义 — an
 * observed false positive, not a hypothetical one. Contact nouns (电话, 邮箱,
 * 联系, 地址) are deliberately NOT stopwords: they are the pivot terms a
 * contact-collection round searches for.
 */
const CJK_STOPWORDS = new Set([
  "定义", "介绍", "简介", "什么", "什么是", "怎么", "如何", "哪些", "哪个",
  "更多", "相关", "内容", "首页", "官网", "下载", "免费", "在线", "详情",
  "百科", "资料", "信息", "文档", "教程", "说明", "全部", "最新", "推荐"
]);

const TRACKING_PARAM_PATTERNS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^msclkid$/i, /^spm$/i, /^scm$/i,
  /^from$/i, /^ref$/i, /^referrer$/i, /^source$/i, /^src$/i, /^_?t$/i, /^eqid$/i, /^form$/i
];

/**
 * Engines that can actually answer an OSINT query from this environment.
 *
 * Measured with a live `site:example.com` probe: Sogou and 360 both honour the
 * operator and return the one page that exists on that domain; Bing returns IMDb
 * and dictionary entries for the word "contact" instead. Bing is kept because it
 * is the only engine that answers some English queries, but the compliance check
 * below is what stops it from poisoning a result set.
 */
const ENGINES: EngineSpec[] = [
  {
    id: "sogou",
    label: "Sogou",
    ownDomains: ["sogou.com", "sogoucdn.com"],
    buildUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    parse: parseSogouSerp
  },
  {
    id: "so360",
    label: "360 Search",
    // 360 answers a query with its own verticals (image.so.com, tv.360kan.com,
    // ai.so.com); they are navigation, not external findings.
    ownDomains: ["so.com", "360kan.com", "360.com", "360.cn", "qhimg.com"],
    buildUrl: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    parse: parseSo360Serp
  },
  {
    id: "bing",
    label: "Bing",
    ownDomains: ["bing.com", "bing.net", "msn.com"],
    buildUrl: (query, maxResults) =>
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}`,
    parse: parseBingSerp
  }
];

export function createOsintSearchTool(dependencies: OsintToolDependencies = {}) {
  return defineTool({
    name: "osint_search",
    label: "OSINT Search",
    description: [
      "Search the public internet for information about a target: related domains and hosts, contact details, people, exposed documents, system fingerprints.",
      "Pass several query phrasings at once (up to 6) so one call covers one round of collection; refine from the results and call again.",
      "Strictly passive: this tool only talks to third-party search engines and never contacts the target itself.",
      "Every result carries per-engine coverage, so a blocked or operator-ignoring engine is reported as such and never as 'the target has nothing public'."
    ].join(" "),
    parameters: Type.Object({
      queries: Type.Array(Type.String({ minLength: 2, maxLength: 500 }), {
        minItems: 1,
        maxItems: MAX_QUERIES_PER_CALL,
        description: "Query variants to run in one round, e.g. a bare domain, a site:-scoped query and an organization name."
      }),
      engines: Type.Optional(Type.Array(
        Type.Union([Type.Literal("sogou"), Type.Literal("so360"), Type.Literal("bing")]),
        { minItems: 1, description: "Restrict to specific engines. Defaults to all enabled engines." }
      )),
      maxResults: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_RESULTS_LIMIT,
        description: `Maximum results returned per query after filtering. Defaults to ${DEFAULT_MAX_RESULTS}.`
      }))
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => toolJsonResult(await searchOsint({
      queries: params.queries,
      engines: params.engines,
      maxResults: params.maxResults
    }, dependencies))
  });
}

export type OsintSearchInput = {
  queries: string[];
  engines?: OsintEngineId[];
  maxResults?: number;
};

export async function searchOsint(
  input: OsintSearchInput,
  dependencies: OsintToolDependencies = {}
): Promise<Record<string, unknown>> {
  const queries = normalizeQueries(input.queries);
  const maxResults = clampInt(input.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT);
  const engines = selectEngines(input.engines);

  if (queries.length === 0) {
    return {
      success: false,
      resultClass: "source_failure",
      negativeSignalStrength: "none",
      queries: [],
      sourceCoverage: {},
      results: [],
      evidenceSummary: "osint_search was called without a usable query.",
      recommendedNextSteps: ["Provide at least one query of two or more characters."]
    };
  }

  if (engines.length === 0) {
    return {
      success: false,
      resultClass: "source_failure",
      negativeSignalStrength: "none",
      queries,
      sourceCoverage: {},
      results: [],
      evidenceSummary: "osint_search was called with an engine list that matches no enabled engine.",
      recommendedNextSteps: ["Omit `engines` to use every enabled engine."]
    };
  }

  const outcomes: QueryOutcome[] = [];

  // Engines run concurrently; each engine's own queries run in order so a single
  // engine is never hit with a burst.
  await Promise.all(engines.map(async (engine) => {
    for (const query of queries) {
      outcomes.push(await runQuery(engine, query, maxResults, dependencies));
    }
  }));

  const { results, dropped, keptPerEngine } = selectResults(outcomes, queries, maxResults, engines);
  const sourceCoverage = buildCoverage(engines, outcomes, keptPerEngine, dropped);
  const resultClass = classifyResult(results, sourceCoverage);
  const droppedCounts = summarizeDrops(dropped);

  return {
    success: resultClass !== "source_failure",
    resultClass,
    negativeSignalStrength: resultClass === "no_public_hit" ? "weak" : "none",
    queries,
    sourceCoverage,
    results,
    droppedCounts,
    evidenceSummary: summarizeEvidence(queries, resultClass, results, sourceCoverage, droppedCounts),
    recommendedNextSteps: recommendNextSteps(resultClass, results, sourceCoverage)
  };
}

async function runQuery(
  engine: EngineSpec,
  query: string,
  maxResults: number,
  dependencies: OsintToolDependencies
): Promise<QueryOutcome> {
  const fetchImpl = (dependencies.fetch ?? globalThis.fetch) as OsintFetch;
  const url = engine.buildUrl(query, maxResults);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": ACCEPT_LANGUAGE
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return { engine: engine.id, query, outcome: "error", hits: [], error: errorMessage(error) };
  }

  if (!response.ok) {
    return {
      engine: engine.id,
      query,
      outcome: "error",
      hits: [],
      error: `HTTP ${response.status}`
    };
  }

  const html = await readBoundedText(response);
  if (looksBlocked(html)) {
    return {
      engine: engine.id,
      query,
      outcome: "blocked",
      hits: [],
      error: "anti-bot or verification page"
    };
  }

  try {
    return { engine: engine.id, query, outcome: "parsed", hits: engine.parse(html, url) };
  } catch (error) {
    return { engine: engine.id, query, outcome: "error", hits: [], error: errorMessage(error) };
  }
}

type DroppedHit = {
  engine: OsintEngineId;
  query: string;
  reason: "site_mismatch" | "irrelevant" | "engine_property";
};

function selectResults(
  outcomes: QueryOutcome[],
  queries: string[],
  maxResults: number,
  engines: EngineSpec[]
): {
  results: OsintResult[];
  dropped: DroppedHit[];
  keptPerEngine: Map<OsintEngineId, number>;
} {
  const constraints = new Map<string, string | undefined>(
    queries.map((query) => [query, extractSiteConstraint(query)])
  );
  const tokens = new Map<string, string[]>(
    queries.map((query) => [query, distinctiveTokens(query)])
  );
  const ownDomains = new Map<OsintEngineId, string[]>(
    engines.map((engine) => [engine.id, engine.ownDomains])
  );
  const dropped: DroppedHit[] = [];
  const keptPerEngine = new Map<OsintEngineId, number>();
  const seen = new Set<string>();
  const results: OsintResult[] = [];

  for (const outcome of outcomes) {
    if (outcome.outcome !== "parsed") {
      continue;
    }
    const siteHost = constraints.get(outcome.query);
    const queryTokens = tokens.get(outcome.query) ?? [];
    const engineDomains = ownDomains.get(outcome.engine) ?? [];
    let keptForQuery = 0;

    for (const hit of outcome.hits) {
      if (keptForQuery >= maxResults) {
        break;
      }
      const host = hostOf(hit.url) ?? hostOf(hit.displayUrl ?? "");
      if (host && engineDomains.some((domain) => hostMatchesDomain(host, domain))) {
        dropped.push({ engine: outcome.engine, query: outcome.query, reason: "engine_property" });
        continue;
      }
      const verdict = judgeHit(host, hit, siteHost, queryTokens);
      if (verdict === "site_mismatch" || verdict === "irrelevant") {
        dropped.push({ engine: outcome.engine, query: outcome.query, reason: verdict });
        continue;
      }

      const key = dedupeKey(hit);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      keptForQuery += 1;
      keptPerEngine.set(outcome.engine, (keptPerEngine.get(outcome.engine) ?? 0) + 1);
      results.push({
        title: hit.title,
        url: hit.url,
        ...(hit.displayUrl ? { displayUrl: hit.displayUrl } : {}),
        snippet: hit.snippet,
        engine: outcome.engine,
        query: outcome.query,
        relevance: verdict,
        ...(hit.flags && hit.flags.length > 0 ? { flags: hit.flags } : {})
      });
    }
  }

  return { results, dropped, keptPerEngine };
}

function judgeHit(
  host: string | undefined,
  hit: OsintHit,
  siteHost: string | undefined,
  queryTokens: string[]
): "site_match" | "token_match" | "site_mismatch" | "irrelevant" {
  if (siteHost) {
    // A `site:` query states the answer set structurally, so host compliance is
    // both necessary and sufficient — token matching would only add noise.
    return host && hostMatchesDomain(host, siteHost) ? "site_match" : "site_mismatch";
  }
  if (queryTokens.length === 0) {
    return "token_match";
  }
  const haystack = `${hit.title} ${hit.snippet} ${hit.url} ${hit.displayUrl ?? ""}`.toLowerCase();
  return queryTokens.some((token) => haystack.includes(token)) ? "token_match" : "irrelevant";
}

function buildCoverage(
  engines: EngineSpec[],
  outcomes: QueryOutcome[],
  keptPerEngine: Map<OsintEngineId, number>,
  dropped: DroppedHit[]
): Record<string, OsintSourceCoverage> {
  const coverage: Record<string, OsintSourceCoverage> = {};
  for (const engine of engines) {
    const own = outcomes.filter((item) => item.engine === engine.id);
    const hits = own.reduce((total, item) => total + item.hits.length, 0);
    const kept = keptPerEngine.get(engine.id) ?? 0;
    const parsed = own.filter((item) => item.outcome === "parsed");
    const blocked = own.filter((item) => item.outcome === "blocked");
    const errored = own.filter((item) => item.outcome === "error");
    const ownDrops = dropped.filter((item) => item.engine === engine.id);

    let status: OsintSourceStatus;
    let reason: string | undefined;

    if (kept > 0) {
      status = "ok";
      const filtered = ownDrops.filter((item) => item.reason !== "engine_property").length;
      if (filtered > 0) {
        reason = `${filtered} further result(s) dropped by site: compliance or the relevance gate`;
      }
    } else if (blocked.length > 0 && parsed.length === 0 && errored.length === 0) {
      status = "blocked";
      reason = blocked[0]?.error;
    } else if (hits > 0 && parsed.length > 0 && errored.length === 0 && blocked.length === 0) {
      // The engine answered with parseable results that every filter rejected.
      // Which filter rejected them is the diagnosis, and the two are not the
      // same defect: ignoring `site:` is an engine capability gap, while failing
      // the relevance gate means the engine answered a different question.
      const siteMismatch = ownDrops.filter((item) => item.reason === "site_mismatch").length;
      const irrelevant = ownDrops.filter((item) => item.reason === "irrelevant").length;
      if (siteMismatch + irrelevant === 0) {
        // Everything the SERP offered was the engine's own navigation.
        status = "no_results";
        reason = "the SERP contained only the engine's own properties";
      } else if (siteMismatch >= irrelevant) {
        status = "operator_unsupported";
        reason = `all ${siteMismatch} parsed result(s) are off the domain named by the site: operator`;
      } else {
        status = "irrelevant";
        reason = `all ${irrelevant} parsed result(s) lack every distinctive query term`;
      }
    } else if (parsed.length > 0 && errored.length === 0 && blocked.length === 0) {
      status = "no_results";
    } else if (parsed.length > 0) {
      status = "no_results";
      reason = `${errored.length + blocked.length} of ${own.length} requests failed`;
    } else {
      status = "error";
      reason = errored[0]?.error ?? blocked[0]?.error ?? "no response parsed";
    }

    coverage[engine.id] = { status, hits, kept, ...(reason ? { reason } : {}) };
  }
  return coverage;
}

function classifyResult(
  results: OsintResult[],
  coverage: Record<string, OsintSourceCoverage>
): "direct_hit" | "mention_hit" | "no_public_hit" | "source_failure" {
  if (results.some((item) => item.relevance === "site_match")) {
    return "direct_hit";
  }
  if (results.length > 0) {
    return "mention_hit";
  }
  const statuses = Object.values(coverage).map((item) => item.status);
  if (statuses.length > 0 && statuses.every((status) => status === "error" || status === "blocked")) {
    return "source_failure";
  }
  return "no_public_hit";
}

function summarizeDrops(dropped: DroppedHit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of dropped) {
    const key = `${item.engine}:${item.reason}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function summarizeEvidence(
  queries: string[],
  resultClass: string,
  results: OsintResult[],
  coverage: Record<string, OsintSourceCoverage>,
  droppedCounts: Record<string, number>
): string {
  const quoted = queries.map((query) => `"${query}"`).join(", ");
  const droppedTotal = Object.values(droppedCounts).reduce((total, count) => total + count, 0);
  const unusable = Object.entries(coverage)
    .filter(([, item]) => item.status !== "ok" && item.status !== "no_results")
    .map(([id, item]) => `${id}=${item.status}`);

  const parts: string[] = [];
  if (results.length > 0) {
    parts.push(`Public search for ${quoted} returned ${results.length} usable result(s) across ${new Set(results.map((item) => item.engine)).size} engine(s).`);
    const siteHits = results.filter((item) => item.relevance === "site_match").length;
    parts.push(siteHits > 0
      ? `${siteHits} of them are hosted on the domain named by a site: operator, so they are on-target rather than merely mentioning it.`
      : "None of them were constrained by a site: operator, so treat them as mentions that still need confirming on the target.");
  } else if (resultClass === "source_failure") {
    parts.push(`No engine produced a usable response for ${quoted}; every source failed or was blocked.`);
  } else {
    parts.push(`No usable public result was found for ${quoted} in the queried engines.`);
  }
  if (droppedTotal > 0) {
    parts.push(`${droppedTotal} parsed result(s) were discarded by site: compliance or the relevance gate, which is why raw hit counts differ from kept counts.`);
  }
  if (unusable.length > 0) {
    parts.push(`Sources not contributing usable results: ${unusable.join(", ")}.`);
  }
  if (resultClass === "no_public_hit") {
    parts.push("This is weak negative evidence: it covers only the queried engines and phrasings, not the whole internet.");
  }
  return parts.join(" ");
}

function recommendNextSteps(
  resultClass: string,
  results: OsintResult[],
  coverage: Record<string, OsintSourceCoverage>
): string[] {
  if (resultClass === "source_failure") {
    return [
      "Retry, or re-run with a single engine to isolate which source is failing.",
      "Do not record the target as having no public footprint — every source failed, so this round produced no evidence either way."
    ];
  }
  if (Object.values(coverage).some((item) => item.status === "operator_unsupported")) {
    return [
      "At least one engine returned results that ignore the site: operator; do not use it for operator-scoped enumeration.",
      "Re-issue operator queries against an engine whose coverage status is ok.",
      "Use web_fetch on the surviving result URLs to read the pages, since search snippets are leads only."
    ];
  }
  if (results.length === 0) {
    return [
      "Reformulate: try the organization name, an email pattern, a page-title phrase or a filename instead of the domain.",
      "Try the same query on the engines whose coverage status is not no_results.",
      "Absence from these engines and phrasings is not absence from the internet."
    ];
  }
  return [
    "Read the most promising results with web_fetch before treating anything as confirmed.",
    "Pivot on the entities these results expose (organization name, hostnames, mail patterns, people) and search again.",
    "Confirm every finding in a second independent source before recording it as observed."
  ];
}

function normalizeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of queries) {
    const query = raw.trim();
    if (query.length < 2 || seen.has(query)) {
      continue;
    }
    seen.add(query);
    normalized.push(query);
    if (normalized.length >= MAX_QUERIES_PER_CALL) {
      break;
    }
  }
  return normalized;
}

function selectEngines(requested: OsintEngineId[] | undefined): EngineSpec[] {
  if (!requested || requested.length === 0) {
    return ENGINES;
  }
  const wanted = new Set(requested);
  return ENGINES.filter((engine) => wanted.has(engine.id));
}

/** `site:example.com` — the operator this whole tool exists to defend. */
export function extractSiteConstraint(query: string): string | undefined {
  const match = query.match(/(?:^|\s)site:([^\s/]+)/i);
  if (!match) {
    return undefined;
  }
  const host = match[1].toLowerCase().replace(/^\*\./, "").replace(/\/$/, "");
  return host.includes(".") ? host : undefined;
}

/**
 * Dot-anchored suffix match, mirroring `authorizedScopeContainsDomain` in
 * `src/scope.ts` so `site:` compliance and scope membership cannot drift apart.
 * `notexample.com` and `example.com.evil.net` are deliberately NOT matches.
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const candidate = host.toLowerCase().replace(/\.$/, "");
  const pattern = domain.toLowerCase().replace(/\.$/, "");
  if (!candidate || !pattern) {
    return false;
  }
  return candidate === pattern || candidate.endsWith(`.${pattern}`);
}

/** Query terms that carry target identity, with operators and stopwords removed. */
export function distinctiveTokens(query: string): string[] {
  const cleaned = query
    .replace(/\b(?:site|inurl|intitle|intext|filetype|ext|inanchor):\S+/gi, " ")
    .replace(/["'()[\]]/g, " ");
  const latin = cleaned.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [];
  const cjk = cleaned.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g) ?? [];
  const tokens = [...latin, ...cjk]
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token) && !CJK_STOPWORDS.has(token));
  return [...new Set(tokens)].slice(0, 8);
}

function hostOf(rawUrl: string): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function dedupeKey(hit: OsintHit): string {
  const normalized = normalizeUrl(hit.url) ?? normalizeUrl(hit.displayUrl ?? "");
  return normalized || `${hit.title}|${hit.snippet}`.toLowerCase();
}

export function normalizeUrl(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(key))) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const search = parsed.searchParams.toString();
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.hostname}${path}${search ? `?${search}` : ""}`;
}

function looksBlocked(html: string): boolean {
  const sample = html.slice(0, 20_000).toLowerCase();
  return [
    "百度安全验证",
    "请输入验证码",
    "验证码",
    "captcha",
    "unusual traffic",
    "verify you are human",
    "are you a robot",
    "just a moment",
    "cf-challenge",
    "安全验证",
    "enable javascript",
    "requires javascript",
    "请开启javascript"
  ].some((marker) => sample.includes(marker));
}

async function readBoundedText(response: Response): Promise<string> {
  const body = await response.text();
  return body.length > MAX_HTML_BYTES ? body.slice(0, MAX_HTML_BYTES) : body;
}

function parseSogouSerp(html: string): OsintHit[] {
  return parseDocument(html, (document) => {
    const hits: OsintHit[] = [];
    // The `vrwrap` container also wraps an ad/site-info card that carries no
    // `vr-title`, so the title heading is the discriminator rather than the id.
    for (const wrap of [...document.querySelectorAll("div.vrwrap")]) {
      const anchor = wrap.querySelector("h3.vr-title a");
      if (!anchor) {
        continue;
      }
      const cite = wrap.querySelector("a.citeLinkClass");
      const displayUrl = cite ? urlLikeSpanText(cite) : undefined;
      const realUrl = resolveSogouUrl(anchor.getAttribute("href"), displayUrl);
      if (!realUrl) {
        continue;
      }
      hits.push({
        title: text(anchor),
        url: realUrl,
        ...(displayUrl ? { displayUrl } : {}),
        snippet: text(wrap.querySelector("div.fz-mid")),
        ...(displayUrl?.endsWith("...") ? { flags: ["path_truncated"] } : {})
      });
    }
    return hits;
  });
}

function parseSo360Serp(html: string): OsintHit[] {
  return parseDocument(html, (document) => {
    const hits: OsintHit[] = [];
    for (const item of [...document.querySelectorAll("li.res-list")]) {
      const anchor = item.querySelector("h3.res-title a") ?? item.querySelector("h3 a");
      if (!anchor) {
        continue;
      }
      // `data-mdurl` is the only place 360 exposes the real destination; the
      // href is a session-bound /link?m= wrapper that 400s without cookies.
      const realUrl = anchor.getAttribute("data-mdurl") ?? anchor.getAttribute("href") ?? "";
      if (!hostOf(realUrl)) {
        continue;
      }
      const cite = item.querySelector(".g-linkinfo cite");
      const flags: string[] = [];
      if (item.querySelector(".dead-link")) {
        flags.push("engine_flagged_unreachable");
      }
      hits.push({
        title: text(anchor),
        url: realUrl,
        ...(cite ? { displayUrl: text(cite) } : {}),
        snippet: text(item.querySelector("p.res-desc")),
        ...(flags.length > 0 ? { flags } : {})
      });
    }
    return hits;
  });
}

function parseBingSerp(html: string): OsintHit[] {
  return parseDocument(html, (document) => {
    const hits: OsintHit[] = [];
    for (const item of [...document.querySelectorAll("li.b_algo")]) {
      const anchor = item.querySelector("h2 a");
      if (!anchor) {
        continue;
      }
      const wrapper = anchor.getAttribute("href") ?? "";
      hits.push({
        title: text(anchor),
        url: decodeBingWrapper(wrapper),
        snippet: text(item.querySelector("p"))
      });
    }
    return hits;
  });
}

function parseDocument<T>(html: string, extract: (document: Document) => T): T {
  // Search engines inline megabytes of unparseable CSS; jsdom reports every
  // failure through its virtual console, which would otherwise flood the tool
  // output with stylesheet noise that has nothing to do with the result set.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { virtualConsole });
  try {
    return extract(dom.window.document);
  } finally {
    dom.window.close();
  }
}

function text(node: Element | null | undefined): string {
  return node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** Sogou's cite block puts the site name and the date in sibling spans. */
function urlLikeSpanText(anchor: Element): string | undefined {
  for (const span of [...anchor.querySelectorAll("span")]) {
    const value = text(span);
    if (!value || span.classList.contains("cite-date")) {
      continue;
    }
    if (/^https?:\/\//i.test(value) || (/^[\w-]+(\.[\w-]+)+/.test(value) && !/\s/.test(value))) {
      return value;
    }
  }
  return undefined;
}

/**
 * Sogou exposes a session-bound `/link?url=` wrapper plus a display URL that may
 * be path-truncated ("https://baike.baidu.com/i..."). Prefer whichever is a
 * usable absolute URL.
 */
function resolveSogouUrl(href: string | null, displayUrl: string | undefined): string | undefined {
  const absoluteDisplay = displayUrl && /^https?:\/\//i.test(displayUrl) ? displayUrl : undefined;
  if (absoluteDisplay) {
    return absoluteDisplay;
  }
  if (href && /^https?:\/\//i.test(href)) {
    return href;
  }
  return displayUrl;
}

/** `https://www.bing.com/ck/a?...&u=a1<base64url-of-target>` -> the target URL. */
export function decodeBingWrapper(href: string): string {
  const match = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (!match) {
    return href;
  }
  const padded = match[1] + "=".repeat((4 - (match[1].length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, "base64url").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

function clampInt(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function toolJsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
