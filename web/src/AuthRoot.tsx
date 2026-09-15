import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Spin } from "antd";
import { AuthScreen } from "./components/AuthScreen";
import { HomePage } from "./components/HomePage";
import { appDestination, loginDestination, parseEntryPage } from "./entryNavigation";
import { useLanguage } from "./language";
import { useAuth } from "./useAuth";
import "./styles/entry.css";

const App = lazy(() => import("./App"));

export function AuthRoot() {
  const auth = useAuth();
  const { locale } = useLanguage();
  const [search, setSearch] = useState(() => window.location.search);
  const page = parseEntryPage(search);
  const navigate = useCallback((href: string, replace = false) => {
    window.history[replace ? "replaceState" : "pushState"]({}, "", href);
    setSearch(window.location.search);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);

  useEffect(() => {
    const restore = () => setSearch(window.location.search);
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    if (auth.loading || page === "home") return;
    // Workbench history changes independently; recover its latest destination.
    const current = window.location.search;
    if (!auth.user && page === "app") navigate(loginDestination(current), true);
    else if (auth.user && page === "login") navigate(appDestination(current), true);
  }, [auth.loading, auth.user, page, search, navigate]);

  const onHome = () => { auth.clearError(); navigate("?page=home"); };
  if (page === "home") {
    return <HomePage authenticated={Boolean(auth.user)} workbenchUrl={appDestination("?view=overview")} wallboardUrl={appDestination("?view=wallboard")} loginUrl={loginDestination("?view=overview")} onNavigate={navigate} />;
  }
  const loading = <div className="qx-entry-loading" role="status"><Spin /><span>{locale === "zh-CN" ? "正在载入青玄" : "Loading Qingxuan"}</span></div>;
  if (auth.loading || (page === "login" && auth.user)) return loading;
  if (!auth.user) {
    return (
      <AuthScreen
        submitting={auth.submitting}
        error={auth.error}
        onClearError={auth.clearError}
        onLogin={auth.login}
        onRegister={auth.register}
        onHome={onHome}
      />
    );
  }
  return <Suspense fallback={loading}><App user={auth.user} onLogout={auth.logout} onHome={onHome} /></Suspense>;
}
