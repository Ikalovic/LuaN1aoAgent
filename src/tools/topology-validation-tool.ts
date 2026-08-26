import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve4, resolveCname } from "node:dns/promises";

const CHECKS = ["dns", "http", "tls", "cname", "redirect"] as const;

export function createTopologyValidationTool(): ToolDefinition<any, any, any> {
  return defineTool({
    name: "validate_candidate_asset",
    label: "Validate Candidate Asset",
    description: "Perform bounded low-risk validation of an FOFA candidate using DNS, HTTP HEAD/GET, TLS reachability, CNAME, or redirect checks. Never log in, scan directories, exploit, or expand authorized Scope.",
    parameters: Type.Object({
      candidate: Type.String({ minLength: 1, maxLength: 512 }),
      checks: Type.Optional(Type.Array(Type.Union(CHECKS.map((check) => Type.Literal(check))), { minItems: 1, maxItems: CHECKS.length }))
    }, { additionalProperties: false }),
    execute: async (_callId, params, signal) => validateCandidate(String(params.candidate), params.checks as string[] | undefined, signal)
  });
}

export async function validateCandidate(candidate: string, requestedChecks?: string[], signal?: AbortSignal) {
  const target = normalizeTarget(candidate);
  const checks = (requestedChecks?.length ? requestedChecks : ["dns", "http", "tls", "cname", "redirect"]).filter((check): check is typeof CHECKS[number] => (CHECKS as readonly string[]).includes(check));
  const signals: Record<string, unknown> = {};
  if (checks.includes("dns") || checks.includes("cname")) {
    try { signals.dns = await resolve4(target.hostname); } catch (error) { signals.dns = { error: errorMessage(error) }; }
    if (checks.includes("cname")) {
      try { signals.cname = await resolveCname(target.hostname); } catch (error) { signals.cname = { error: errorMessage(error) }; }
    }
  }
  if (checks.includes("http") || checks.includes("tls") || checks.includes("redirect")) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("validation timeout"), 8_000);
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    try {
      const response = await fetch(target.href, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "*/*" } });
      signals.http = { status: response.status, contentType: response.headers.get("content-type"), server: response.headers.get("server") };
      if (checks.includes("redirect")) signals.redirect = response.headers.get("location");
      if (checks.includes("tls")) signals.tls = target.protocol === "https:" ? "https_reachable" : "not_requested_for_http";
    } catch (error) {
      signals.http = { error: errorMessage(error) };
      if (checks.includes("tls")) signals.tls = { error: errorMessage(error) };
    } finally { clearTimeout(timer); }
  }
  return { content: [{ type: "text" as const, text: JSON.stringify({ candidate: target.hostname, url: target.href, validationStatus: Object.values(signals).some((value) => value && !(typeof value === "object" && "error" in value)) ? "validated" : "pending", active_testing_allowed: false, validationSignals: signals }, null, 2) }], details: signals };
}

function normalizeTarget(value: string): URL {
  const candidate = value.trim();
  const url = /^https?:\/\//i.test(candidate) ? new URL(candidate) : new URL(`https://${candidate}`);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("candidate must be an HTTP(S) host or URL");
  url.pathname = url.pathname || "/";
  return url;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
