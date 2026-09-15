import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchRuns, fetchRuntimeState, fetchSessions, UNAUTHORIZED_EVENT } from "./api";
import { translate } from "./language";
import type { ActiveRun, RuntimeSession, RuntimeState } from "./types";

export interface RuntimeDashboardState {
  data?: RuntimeState;
  /** Requested directory, which may differ from the server's canonical path. */
  loadedRuntimeDir?: string;
  sessions: RuntimeSession[];
  activeRuns: ActiveRun[];
  runsKnown: boolean;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  autoRefresh: boolean;
  visible: boolean;
  /** Client receipt time of the last successful state response. */
  lastSuccessAt?: number;
  delayed: boolean;
  setAutoRefresh: (enabled: boolean) => void;
  refresh: () => Promise<void>;
}

type Snapshot = Pick<RuntimeDashboardState, "data" | "loadedRuntimeDir" | "sessions" | "activeRuns" | "runsKnown" | "lastSuccessAt" | "error" | "loading" | "refreshing"> & { runtimeDir: string };

function emptySnapshot(runtimeDir: string): Snapshot {
  return { runtimeDir, sessions: [], activeRuns: [], runsKnown: false, loading: false, refreshing: false };
}

export function useRuntimeDashboard(runtimeDir: string): RuntimeDashboardState {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ ...emptySnapshot(runtimeDir), loading: !document.hidden }));
  const [autoRefresh, setAutomaticState] = useState(true);
  const automatic = useRef(true);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [delayed, setDelayed] = useState(false);
  const commands = useRef<{ refresh: () => Promise<void>; setAutomatic: (enabled: boolean) => void } | undefined>(undefined);

  const refresh = useCallback(() => commands.current?.refresh() ?? Promise.resolve(), []);
  const setAutoRefresh = useCallback((enabled: boolean) => commands.current?.setAutomatic(enabled), []);

  useEffect(() => {
    let active = true;
    let foreground = !document.hidden;
    let needsBaseline = true;
    let sequence = 0;
    let controller: AbortController | undefined;
    let pollTimer: number | undefined;
    let freshnessTimer: number | undefined;

    function resetFreshness() {
      window.clearTimeout(freshnessTimer);
      setDelayed(false);
      if (automatic.current && foreground) {
        freshnessTimer = window.setTimeout(() => {
          if (active && automatic.current && foreground) setDelayed(true);
        }, 20001);
      }
    }

    function cancel() {
      ++sequence;
      controller?.abort();
      window.clearTimeout(pollTimer);
    }

    function setAutomatic(enabled: boolean) {
      if (!active || enabled === automatic.current) return;
      automatic.current = enabled;
      if (!enabled) needsBaseline = false;
      setAutomaticState(enabled);
      cancel();
      resetFreshness();
      setSnapshot((current) => ({ ...current, loading: false, refreshing: false }));
      if (enabled && foreground) void load();
    }

    function onUnauthorized() {
      if (!active) return;
      cancel();
      automatic.current = false;
      needsBaseline = false;
      setAutomaticState(false);
      resetFreshness();
      setSnapshot(emptySnapshot(runtimeDir));
    }

    async function load() {
      if (!active || !foreground) return;
      cancel();
      const requestId = sequence;
      const requestController = new AbortController();
      controller = requestController;
      const current = () => active && requestId === sequence && !requestController.signal.aborted;
      setSnapshot((previous) => ({ ...previous, loading: !previous.data, refreshing: true }));
      let successAt: number | undefined;

      const results = await Promise.allSettled([
        fetchRuntimeState(runtimeDir, requestController.signal).then((data) => {
          if (current()) {
            successAt = Date.now();
            resetFreshness();
          }
          return data;
        }),
        fetchRuns(requestController.signal),
        fetchSessions(runtimeDir, requestController.signal)
      ]);
      if (!current()) return;
      needsBaseline = false;
      const [stateResult, runsResult, sessionsResult] = results;
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.some((result) => result.reason instanceof ApiError && result.reason.status === 401)) {
        onUnauthorized();
        return;
      }
      if (failures.some((result) => result.reason instanceof ApiError && result.reason.status === 403)) {
        automatic.current = false;
        setAutomaticState(false);
        resetFreshness();
      }
      setSnapshot((previous) => ({
        ...previous,
        ...(stateResult.status === "fulfilled" ? { data: stateResult.value, loadedRuntimeDir: runtimeDir, lastSuccessAt: successAt } : {}),
        sessions: sessionsResult.status === "fulfilled" ? sessionsResult.value.sessions || [] : previous.sessions,
        activeRuns: runsResult.status === "fulfilled" ? runsResult.value.runs || [] : [],
        runsKnown: runsResult.status === "fulfilled",
        loading: false,
        refreshing: false,
        error: stateResult.status === "rejected" ? translate("dashboard.runtimeFailed", { error: errorText(stateResult.reason) })
          : sessionsResult.status === "rejected" ? translate("dashboard.sessionsFailed", { error: errorText(sessionsResult.reason) })
            : runsResult.status === "rejected" ? errorText(runsResult.reason) : undefined
      }));
      if (automatic.current && foreground) pollTimer = window.setTimeout(() => { void load(); }, 5000);
    }

    function onVisibilityChange() {
      foreground = !document.hidden;
      setVisible(foreground);
      cancel();
      resetFreshness();
      setSnapshot((current) => ({ ...current, loading: false, refreshing: false }));
      if (foreground && (automatic.current || needsBaseline)) void load();
    }

    setSnapshot(emptySnapshot(runtimeDir));
    setVisible(foreground);
    commands.current = { refresh: load, setAutomatic };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    resetFreshness();
    if (foreground) void load();
    return () => {
      active = false;
      cancel();
      window.clearTimeout(freshnessTimer);
      commands.current = undefined;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, [runtimeDir]);

  const currentSnapshot = snapshot.runtimeDir === runtimeDir ? snapshot : emptySnapshot(runtimeDir);
  return { ...currentSnapshot, autoRefresh, visible, delayed, setAutoRefresh, refresh };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
