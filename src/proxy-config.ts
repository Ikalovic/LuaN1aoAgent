import { isIP } from "node:net";

export type TransparentSocks5ProxyConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
};

export function parseTransparentProxy(value: string): TransparentSocks5ProxyConfig {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--proxy must be a valid socks5:// URL");
  }
  if (url.protocol !== "socks5:") throw new Error("--proxy currently supports only socks5:// URLs");
  if (!url.hostname || isIP(url.hostname) === 6) throw new Error("--proxy requires an IPv4 address or hostname");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("--proxy must not contain a path, query, or fragment");
  }
  const username = decodeUrlCredential(url.username, "username");
  const password = decodeUrlCredential(url.password, "password");
  if (!username || !password) throw new Error("--proxy requires username and password authentication");
  if (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) {
    throw new Error("--proxy username and password must contain at most 255 bytes");
  }
  const port = url.port ? Number(url.port) : 1080;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--proxy has an invalid port");
  return { host: url.hostname, port, username, password };
}

export function transparentProxyEndpoint(config: TransparentSocks5ProxyConfig): string {
  return `${config.host}:${config.port}`;
}

function decodeUrlCredential(value: string, field: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`--proxy has invalid percent-encoding in its ${field}`);
  }
}
