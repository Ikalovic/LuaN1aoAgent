# Internet Info-Gathering Data Sources — Authorized Recon Survey

Probe date **2026-09-16**. "Verified" = I issued a live HTTP request and read the response. Compacted to fit budget.

> **ENVIRONMENT CAVEAT.** Every external host I probed resolved to `198.18.0.0/15` (RFC 2544 range) — `crt.sh`→`198.18.0.149`,
> `api.shodan.io`→`198.18.0.185`. DNS is intercepted; egress goes through a local proxy. "Reachable" = reachable *through this
> proxy*, which may be better-connected than a mainland-China deployment. Reachability is indicative, not guaranteed.

## 1. Zero-key tier

| Source | Exact endpoint | Answers | Verified |
|---|---|---|---|
| crt.sh | `https://crt.sh/?q=%25.<d>&output=json` | subdomains via CT logs | **yes** |
| Cert Spotter | `https://api.certspotter.com/v1/issuances?domain=<d>&include_subdomains=true&expand=dns_names` | deduped subdomains + certs | **yes** |
| Cloudflare DoH | `https://cloudflare-dns.com/dns-query?name=<d>&type=<T>` + `Accept: application/dns-json` | any RR: A/MX/TXT/NS/SOA/CAA/DNSKEY | **yes** |
| Cloudflare DoH (IP host) | `https://1.1.1.1/dns-query?name=<d>&type=<T>` same header | same, no hostname dep | **yes** |
| Google DoH | `https://dns.google/resolve?name=<d>&type=<T>` | same; `DS` also worked | **yes** |
| Shodan InternetDB | `https://internetdb.shodan.io/<ip>` | per-IP ports, hostnames, CPEs, vulns | **yes** |
| RDAP domain | `https://rdap.org/domain/<d>` | registrar, NS, status, dates | **yes** |
| RDAP IP | `https://rdap.org/ip/<ip>` | netblock holder / allocation | **yes** |
| RIPE Stat prefix | `https://stat.ripe.net/data/prefix-overview/data.json?resource=<ip>` | ASN owning an IP | **yes** |
| RIPE Stat prefixes | `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS<n>` | **all prefixes of an ASN → IP range for `--scope`** | **yes** |
| RIPE Stat PTR | `https://stat.ripe.net/data/reverse-dns/data.json?resource=<ip>` | reverse DNS | **yes** |
| RIPE Stat AS | `https://stat.ripe.net/data/as-overview/data.json?resource=AS<n>` | AS name/holder | **yes** |
| hackertarget hostsearch | `https://api.hackertarget.com/hostsearch/?q=<d>` | subdomains + IPs | **yes** |
| hackertarget dnslookup | `https://api.hackertarget.com/dnslookup/?q=<d>` | full RR dump | **yes** |
| hackertarget reversedns | `https://api.hackertarget.com/reversedns/?q=<ip>` | PTR | **yes** |
| hackertarget aslookup | `https://api.hackertarget.com/aslookup/?q=<ip>` | ASN + netblock + country | **yes** |
| hackertarget findshareddns | `https://api.hackertarget.com/findshareddns/?q=<d>` | vhost neighbours on same IP | **yes** |
| hackertarget httpheaders | `https://api.hackertarget.com/httpheaders/?q=<d>` | live HTTP headers (fingerprint) | **yes** |
| hackertarget pagelinks | `https://api.hackertarget.com/pagelinks/?q=<d>` | outbound links | **yes** |
| hackertarget zonetransfer | `https://api.hackertarget.com/zonetransfer/?q=<d>` | AXFR attempt | **yes** |
| urlscan.io search | `https://urlscan.io/api/v1/search/?q=domain%3A<d>` | pages/URLs others already scanned | **yes** |
| Wayback CDX | `https://web.archive.org/cdx/search/cdx?url=<d>*&output=json&limit=N` | historical URL inventory | **yes** (HTTPS only) |
| Wayback availability | `https://archive.org/wayback/available?url=<d>` | nearest snapshot | **yes** |
| Common Crawl index list | `https://index.commoncrawl.org/collinfo.json` | available crawl indexes | **yes** |
| Common Crawl index | `https://index.commoncrawl.org/CC-MAIN-2026-34-index?url=<d>/*&output=json&limit=N` | crawled URLs + WARC offsets | **yes** |
| OTX general | `https://otx.alienvault.com/api/v1/indicators/domain/<d>/general` | pulses, geo, whois links | **yes** |
| OTX url_list | `https://otx.alienvault.com/api/v1/indicators/domain/<d>/url_list?limit=N` | observed URLs | **yes** |
| HIBP breach catalog | `https://haveibeenpwned.com/api/v3/breaches` | list of *all* breaches (not per-account) | **yes** |
| GitHub repo search | `https://api.github.com/search/repositories?q=<x>` | repo discovery, 60/hr anon | **yes** |
| Sourcegraph stream | `https://sourcegraph.com/.api/search/stream?q=<x>&v=V3&t=literal&display=N` | public code search | **yes** |
| Mail posture (DoH TXT) | `_dmarc.<d>`, `_mta-sts.<d>`, `default._bimi.<d>` | SPF/DMARC/MTA-STS/BIMI presence | **yes** |
| MTA-STS policy | `https://mta-sts.<d>/.well-known/mta-sts.txt` | mode enforce/testing/none + mx list | **yes** |
| security.txt | `https://<d>/.well-known/security.txt` | security contact + disclosure policy | **yes** |
| Google CT log list | `https://www.gstatic.com/ct/log_list/v3/log_list.json` | CT log inventory | **unverified** |
| ARIN/APNIC RDAP direct | `https://rdap.arin.net/registry/ip/<ip>`, `https://rdap.apnic.net/ip/<ip>` | RIR-specific IP data | **unverified** |

## 2. Keyed tier

| Source | Endpoint | Free tier | Verified |
|---|---|---|---|
| FOFA (**already configured**) | `https://fofa.info/api/v1/search/all?qbase64=<b64>` | key required; quota **unverified** | **yes** — alive, `[-700] 账号无效` |
| Shodan keyed | `https://api.shodan.io/shodan/host/<ip>` | InternetDB is the real no-key path | **yes** — 401 on `api-info`/`host/count` w/o key; see trap #1 |
| Shodan InternetDB | `https://internetdb.shodan.io/<ip>` | **free, no key, no signup** | **yes** |
| 360 Quake | `https://quake.360.net/api/v3/search/quake_service` | key required; quota **unverified** | **yes** — `{"code":"q5000"}` |
| Hunter / QiAnXin | `https://hunter.qianxin.com/openApi/search` | key required; quota **unverified** | **yes** — 401 `令牌过期` |
| ZoomEye | `https://api.zoomeye.org/host/search?query=<d>` | key required | **yes** — **502 Bad Gateway** |
| Censys legacy | `https://search.censys.io/api/v2/hosts/<ip>` | API ID+secret; free tier **unverified** | **yes** — 401 |
| Censys Platform | `https://api.platform.censys.io/v3/global/asset/host/<ip>` | PAT; free tier **unverified** | **yes** — 401 |
| GitHub code search | `https://api.github.com/search/code?q=<x>` | **none — auth mandatory** | **yes** — 401 |
| Cert Spotter (token) | as above + token | docs: $0 = 100 hostname q/hr, 10 full-domain q/hr, 75/min, 5/sec | docs read live |
| urlscan.io (key) | `api-key` header (not `x-api-key`) | docs: anon = "minor quotas", free account raises them | docs read live |
| HIBP per-account, DeHashed, Intelligence X, SecurityTrails, GreyNoise, BinaryEdge | — | out of scope per your instruction | **unverified** |

## 3. Live-probe observations (only sources I actually hit)

- **crt.sh** — `%.example.com` → 200, 25 KB JSON, 3.2–4.6 s. Wildcard on a *nonexistent* domain → 200 + `[]` (2 bytes).
  But `%.test1.com` returned **404 twice** in a 5-request burst, then **200 with full data 4/4 on retry**.
  ➜ **404 = overloaded, NOT "no subdomains".** Retry 404/502; only `200`+`[]` means empty.
- **Cert Spotter** — 200 anonymously, no token sent. Headers `x-ratelimit-limit: 10`, `remaining: 8`, `cache-control: public, max-age=14400`.
- **Cloudflare DoH / Google DoH** — all 200. `A, MX, NS, TXT, SOA, CAA, DNSKEY, DS` all valid JSON; multiple A records as separate `Answer[]` entries.
- **Mail posture semantics** — `_dmarc.google.com` → `v=DMARC1; p=reject; rua=...`; `_mta-sts.gmail.com` TXT → `v=STSv1; id=...`;
  `https://mta-sts.google.com/.well-known/mta-sts.txt` → 200 `mode: enforce`; `default._bimi.google.com` → **Status 3 (NXDOMAIN)** = no BIMI;
  `example.com` TXT → `v=spf1 -all`.
- **OTX is split** — `/general` and `/url_list?limit=10` → **200 anon**; `/passive_dns` → **429** `{"detail":"Anonymous access to this endpoint is limited. Please authenticate."}`
- **Wayback CDX** — plain `http://web.archive.org` timed out at 25 s / 0 bytes; `https://` → **200** with header row
  `["urlkey","timestamp","original","mimetype","statuscode","digest","length"]`.
- **urlscan.io search** — **200 with no key** (`domain:example.com`, 9.9 KB).
- **Shodan InternetDB** — 200 JSON no key; `cpes`, `hostnames` (dozens of unrelated vhosts), ports.
- **Sourcegraph** — still open: 200 `text/event-stream`, 482 KB for `q=AKIA&v=V3`.
- **GitHub** — `search/repositories` 200 anon; `search/code` **401 `Requires authentication`**; `rate_limit` 200 (60/hr core).
- **Search-engine scraping, all blocked/degraded:** `html.duckduckgo.com/html/?q=` → **HTTP 202** challenge (14 KB), same for `lite.`;
  `www.baidu.com/s?wd=` → 200 but body is **`百度安全验证`** CAPTCHA (1.5 KB); `yandex.com/search/` → 200 but title **`Verification`** + fp.js anti-bot;
  `www.bing.com/search?q=` → 200, 123 KB, served `lang="fr"` (geo-variable), parseability unverified;
  `search.brave.com/search?q=` → 200, 184 KB SvelteKit shell, JS-rendered, unverified.
- **Dead/broken:** `searchcode.com/api/codesearch_I/` → **404**. Google `transparencyreport/.../certsearch` → **404**.
  `grep.app/api/search` → **429 Vercel Security Checkpoint**. `api.bgpview.io` → **TLS unexpected eof** (HTTPS) / empty reply (HTTP), every attempt.
  `dns.bufferover.run` → **TLS unexpected eof**. `api.threatminer.org` → **timeout 20 s**. `api.zoomeye.org` → **502 nginx**.
- **hackertarget** — `hostsearch, dnslookup, reversedns, aslookup, httpheaders, findshareddns, pagelinks, zonetransfer` → all **200 `text/plain`**.
  `whois/?q=` → **200 but body `error valid key required`**. `geoip/?q=1.1.1.1` → 200 but every field `None`.
  `findshareddns` returns a concatenated blob with inconsistent separators.
- **RIPE Stat** — all 200 JSON, no key; `announced-prefixes` for `AS13335` = 635 KB.
- **FOFA** — alive, key-gated, Chinese error `[-700] 账号无效` returned with **HTTP 200**.
- **security.txt** at `https://www.google.com/.well-known/security.txt` → 200 with `Contact`/`Policy`.

## 4. Traps and false signals

- **`198.18.x.x` everywhere** — DNS is intercepted and egress proxied. Reachability and latency here are not mainland-China reality.
- **Trap #1 — keyless `api.shodan.io/shodan/host/<ip>` returned full paid data (200)** with `cf-cache-status: HIT`, `age: 28295`,
  `cache-control: public, max-age=28800`. A **proxy/cache artifact, not a free tier — do not build on it.** Only `internetdb.shodan.io` is legitimately keyless.
- **crt.sh `404` ≠ "no results"** — real empty is `200` + `[]`. Retry 404/502 with backoff.
- **HTTP 200 does not mean success** — FOFA, Quake, Hunter, hackertarget all return errors with status 200. Inspect the body.
- **CT coverage ≠ live DNS** — issuance lag; only publicly-trusted TLS names; internal-only/non-HTTP subdomains absent.
- **Wildcard certs poison subdomain lists** — strip the leading `*.` or you feed junk hostnames downstream.
- **Missing `_bimi` / `_mta-sts` is normal, not a finding** — check both the TXT record *and* the HTTPS policy file.
- **hackertarget `findshareddns` is reverse-IP, not ownership** — shared-hosting/CDN neighbours are not the target's assets.
- **CDN IPs destroy IP pivoting** — `example.com` → Cloudflare anycast (`104.20.23.154`, `172.66.147.243`); InternetDB for `1.1.1.1` returned unrelated third-party vhosts.
- **`zonetransfer` 200 ≠ AXFR success** — body read `Transfer failed.` for both NS.
- **DDG HTML returns 202**, so `if status == 200` silently discards it; Baidu/Yandex return 200 with CAPTCHA bodies that look like "zero results".
- **Remove dead sources rather than retrying them:** searchcode, Google CT certsearch, bgpview.io, bufferover, threatminer, grep.app, ZoomEye (502).
- **Common Crawl is not current** — latest index `CC-MAIN-2026-34` (2026-08-07→08-20); absence of a URL proves nothing.
- **OTX `/passive_dns` now needs auth** while sibling endpoints do not — "worked last year" ≠ works now.
- **Passivity depends on follow-through** — DNS/CT/CDX/Common Crawl are passive; `httpheaders`, `pagelinks`, `zonetransfer` and any later fetch send packets to the target.

## 5. Ranked: best value per integration cost

1. **Cloudflare/Google DoH JSON** — one GET, no key, every RR type; backbone of DNS + mail-security checks.
2. **crt.sh JSON** — richest single subdomain source, no auth; only cost is retry-on-404 discipline.
3. **RIPE Stat** — converts a `--scope` ASN into a concrete IP range; no key, generous.
4. **Shodan InternetDB** — free per-IP ports/CPEs/vulns, no signup; cheapest host enrichment available.
5. **Wayback CDX (HTTPS)** — historical URL/param inventory; no key; finds forgotten endpoints.
6. **hackertarget suite** — ~8 working no-key endpoints from one vendor (DNS, PTR, ASN, headers, vhost neighbours).
7. **Cert Spotter** — deduped CT with clean `dns_names`; real JSON API; 10/hr anon suffices for a few domains.
8. **urlscan.io search** — already-collected page/URL intel without touching the target; 200 with no key.
9. **RDAP via `rdap.org`** — one URL shape for domains *and* IPs, JSON, no auth; the correct modern WHOIS path.
10. **Sourcegraph public stream** — still open without a key; best remaining code/secret-pattern search.
11. **Common Crawl index** — wide URL history complementing CDX; plain GET, ndjson.
12. **FOFA** (already wired) — keep as primary Chinese attack-surface engine; the only one here indexing non-HTTP services at depth.

**Do not integrate:** bgpview.io, bufferover, searchcode, threatminer, grep.app, Google CT certsearch, ZoomEye (502),
and any Baidu / Yandex / DDG-HTML scraping path.
