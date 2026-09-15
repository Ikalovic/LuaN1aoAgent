import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthRoot } from "./AuthRoot";
import { LanguageProvider } from "./language";
import { ThemeProvider } from "./ThemeProvider";
import "antd/dist/reset.css";
import "./styles.css";
import "./styles/theme.css";
import "./styles/workbench.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <LanguageProvider>
        <AuthRoot />
      </LanguageProvider>
    </ThemeProvider>
  </StrictMode>
);
