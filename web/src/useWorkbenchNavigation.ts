import { useCallback, useEffect, useRef, useState } from "react";
import { navigationUrl, parseNavigation, transitionNavigation, type NavigationState } from "./navigation";
export function useWorkbenchNavigation(allowLeave: () => boolean = () => true) {
  const [state, setState] = useState(() => parseNavigation(window.location.search));
  const current = useRef(state);
  useEffect(() => {
    const restore = () => {
      if (!allowLeave()) { window.history.pushState({}, "", navigationUrl(state)); return; }
      current.current = parseNavigation(window.location.search);
      setState(current.current);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [allowLeave, state]);
  const navigate = useCallback((patch: Partial<NavigationState>, mode: "push" | "replace" = "push") => {
    if (!allowLeave()) return;
    const next = transitionNavigation(current.current, patch);
    current.current = next;
    window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", navigationUrl(next));
    try { localStorage.setItem("luanniao-runtime-dir", next.runtimeDir); } catch { /* Optional persistence. */ }
    setState(next);
  }, [allowLeave]);
  return { state, navigate };
}
