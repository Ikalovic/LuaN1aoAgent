import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, isIPv4, Socket, type Server } from "node:net";

const BROKER_MAGIC = Buffer.from("LNDB1", "ascii");
const BROKER_REQUEST_BYTES = BROKER_MAGIC.length + 32 + 4 + 2;
const BROKER_HANDSHAKE_TIMEOUT_MS = 5_000;
const BROKER_CONNECT_TIMEOUT_MS = 15_000;

export type HostEgressBrokerEndpoint = {
  host: "host.docker.internal";
  port: number;
  token: string;
};

export class HostEgressBroker {
  private readonly token = randomBytes(32);
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  private endpoint?: HostEgressBrokerEndpoint;
  private startPromise?: Promise<HostEgressBrokerEndpoint>;

  start(): Promise<HostEgressBrokerEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    this.startPromise ??= new Promise<HostEgressBrokerEndpoint>((resolve, reject) => {
      const server = createServer((client) => this.accept(client));
      this.server = server;
      server.once("error", reject);
      server.listen({ host: "0.0.0.0", port: 0 }, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Host egress broker did not receive an IPv4 port"));
          return;
        }
        this.endpoint = {
          host: "host.docker.internal",
          port: address.port,
          token: this.token.toString("hex")
        };
        this.log(`listening on 0.0.0.0:${address.port}`);
        server.unref();
        resolve(this.endpoint);
      });
    }).catch((error: unknown) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    this.startPromise = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      for (const socket of this.sockets) socket.destroy();
    });
    this.sockets.clear();
  }

  private accept(client: Socket): void {
    this.trackSocket(client);
    const peer = `${client.remoteAddress ?? "unknown"}:${client.remotePort ?? 0}`;
    let pending = Buffer.alloc(0);
    client.setTimeout(BROKER_HANDSHAKE_TIMEOUT_MS, () => {
      this.log(`handshake from ${peer} timed out; destroying connection`);
      client.destroy();
    });
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < BROKER_REQUEST_BYTES) return;
      client.off("data", onData);
      if (pending.length !== BROKER_REQUEST_BYTES
        || !pending.subarray(0, BROKER_MAGIC.length).equals(BROKER_MAGIC)
        || !timingSafeEqual(pending.subarray(BROKER_MAGIC.length, BROKER_MAGIC.length + 32), this.token)) {
        this.log(`rejected handshake from ${peer}: bad magic or token`);
        client.destroy();
        return;
      }
      const offset = BROKER_MAGIC.length + 32;
      const host = [...pending.subarray(offset, offset + 4)].join(".");
      const port = pending.readUInt16BE(offset + 4);
      if (!isIPv4(host) || port === 0 || deniedHostTarget(host)) {
        this.log(`denied target ${host}:${port} requested by ${peer}`);
        client.end(Buffer.from([1]));
        return;
      }
      this.connect(client, host, port);
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  }

  private connect(client: Socket, host: string, port: number): void {
    const upstream = new Socket();
    this.trackSocket(upstream);
    let connected = false;
    upstream.setTimeout(BROKER_CONNECT_TIMEOUT_MS, () => {
      if (!connected) {
        this.log(`connect to ${host}:${port} timed out after ${BROKER_CONNECT_TIMEOUT_MS}ms`);
        client.end(Buffer.from([2]));
      }
      upstream.destroy();
    });
    upstream.once("connect", () => {
      connected = true;
      upstream.setTimeout(0);
      client.setTimeout(0);
      client.write(Buffer.from([0]));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("error", (error: Error) => {
      if (!connected) {
        this.log(`connect to ${host}:${port} failed: ${error.message}`);
        client.end(Buffer.from([1]));
      } else client.destroy();
    });
    client.once("close", () => upstream.destroy());
    upstream.connect({ host, port });
  }

  private log(message: string): void {
    if (!luanniaoDebugEnabled()) return;
    console.error(`[host-egress-broker] ${message}`);
  }

  private trackSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }
}

export function luanniaoDebugEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LUANNIAO_DEBUG ?? "");
}

function deniedHostTarget(host: string): boolean {
  const octets = host.split(".").map(Number);
  return octets[0] === 127
    || octets[0] === 169 && octets[1] === 254
    || octets[0] >= 224
    || host === "0.0.0.0"
    || host === "255.255.255.255";
}
