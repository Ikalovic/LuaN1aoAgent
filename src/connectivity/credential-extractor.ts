import type { ArtifactStore } from "../stores/artifact-store.js";
import type { TrafficProxyClient, TrafficCredentialHint } from "./traffic-proxy-client.js";

export type CredentialHintExtraction = {
  scopeRef: string;
  host: string;
  kind: string;
  name: string;
  valueHash: string;
  exchangeId: number;
  extractedAt: string;
};

export type CredentialExtractorOptions = {
  pollIntervalMs?: number;
  hosts?: string[];
};

const DEFAULT_POLL_INTERVAL_MS = 10_000;

export class CredentialExtractor {
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt: string | null = null;
  private running = false;

  constructor(
    private readonly client: TrafficProxyClient,
    private readonly store: ArtifactStore,
    private readonly scopeRef: string,
    private readonly options: CredentialExtractorOptions = {}
  ) {}

  async poll(): Promise<CredentialHintExtraction[]> {
    const hosts = this.options.hosts ?? [];
    if (hosts.length === 0) return [];
    const extractions: CredentialHintExtraction[] = [];
    for (const host of hosts) {
      const since = this.lastPollAt ?? undefined;
      const result = await this.client.credentialHints(host, since);
      for (const hint of result.hints) {
        extractions.push(hintToExtraction(hint, this.scopeRef));
      }
    }
    this.lastPollAt = new Date().toISOString();
    return extractions;
  }

  async process(extractions: CredentialHintExtraction[]): Promise<void> {
    for (const extraction of extractions) {
      const data = JSON.stringify({
        kind: extraction.kind,
        name: extraction.name,
        value_hash: extraction.valueHash,
        host: extraction.host,
        exchange_id: extraction.exchangeId,
        extracted_at: extraction.extractedAt,
        scope_ref: extraction.scopeRef
      });
      await this.store.writeCredential({
        data,
        scopeRef: extraction.scopeRef,
        kind: extraction.kind,
        hostRef: extraction.host,
        label: extraction.name,
        source: "traffic_proxy"
      });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.poll()
        .then((extractions) => this.process(extractions))
        .catch((error) => {
          console.error("[CredentialExtractor] poll error:", error);
        });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function hintToExtraction(hint: TrafficCredentialHint, scopeRef: string): CredentialHintExtraction {
  return {
    scopeRef,
    host: hint.host,
    kind: hint.kind,
    name: hint.name,
    valueHash: hint.value_hash,
    exchangeId: hint.exchange_id,
    extractedAt: hint.extracted_at
  };
}
