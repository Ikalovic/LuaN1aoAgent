import { navigationUrl, parseNavigation } from "./navigation";

export type EntryPage = "home" | "login" | "app";

export function parseEntryPage(search: string): EntryPage {
  const params = new URLSearchParams(search);
  if (params.get("page") === "home") return "home";
  if (params.get("page") === "login") return "login";
  return params.has("view") || params.has("runtimeDir") ? "app" : "home";
}

export function appDestination(search: string): string {
  return navigationUrl(parseNavigation(search));
}

export function loginDestination(search: string): string {
  const params = new URLSearchParams(appDestination(search));
  params.set("page", "login");
  return `?${params}`;
}
