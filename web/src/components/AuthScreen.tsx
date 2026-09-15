import { useState } from "react";
import { Alert, Button, Form, Input, Tabs, Tooltip } from "antd";
import { ArrowLeft, Languages, LockKeyhole, Moon, Sun, UserRound } from "lucide-react";
import { useLanguage } from "../language";
import { useTheme } from "../ThemeProvider";
import { Brand } from "./Brand";

interface AuthScreenProps {
  submitting: boolean;
  error?: string;
  onClearError: () => void;
  onLogin: (input: { username: string; password: string }) => Promise<void>;
  onRegister: (input: { username: string; displayName: string; password: string }) => Promise<void>;
  onHome?: () => void;
}

export function AuthScreen(props: AuthScreenProps) {
  const [activeTab, setActiveTab] = useState("login");
  const { locale, t, toggleLocale } = useLanguage();
  const { mode, toggleTheme } = useTheme();
  const themeLabel = locale === "zh-CN" ? (mode === "dark" ? "切换浅色主题" : "切换深色主题") : (mode === "dark" ? "Switch to light theme" : "Switch to dark theme");
  const languageLabel = locale === "zh-CN" ? t("language.switchToEnglish") : t("language.switchToChinese");
  return (
    <div className="auth-shell qx-auth">
      <header className="qx-entry-header">
        <a className="qx-entry-home" href="?page=home" onClick={(event) => { if (props.onHome && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); props.onHome(); } }}><ArrowLeft size={17} /><span>{locale === "zh-CN" ? "返回首页" : "Back to home"}</span></a>
      <div className="auth-preferences">
        <Tooltip title={themeLabel}><Button type="text" icon={mode === "dark" ? <Sun size={18} /> : <Moon size={18} />} aria-label={themeLabel} onClick={toggleTheme} /></Tooltip>
        <Tooltip title={languageLabel}><Button type="text" icon={<Languages size={18} />} aria-label={languageLabel} onClick={toggleLocale} /></Tooltip>
      </div>
      </header>
      <main className="auth-access">
        <div className="auth-panel">
          <Brand className="auth-panel-brand" />
          <h1 className="qx-entry-title">{activeTab === "login" ? (locale === "zh-CN" ? "账号登录" : "Sign in") : (locale === "zh-CN" ? "创建账号" : "Create an account")}</h1>
          {props.error ? <Alert closable type="error" showIcon message={props.error} onClose={props.onClearError} /> : null}
          <Tabs
            activeKey={activeTab}
            onChange={(key) => { setActiveTab(key); props.onClearError(); }}
            items={[
              { key: "login", label: t("auth.login"), children: <LoginForm submitting={props.submitting} onSubmit={props.onLogin} /> },
              { key: "register", label: t("auth.register"), children: <RegisterForm submitting={props.submitting} onSubmit={props.onRegister} /> }
            ]}
          />
        </div>
      </main>
      <footer className="qx-entry-footer">{locale === "zh-CN" ? "本项目基于 " : "Adapted from "}<a href="https://github.com/SanMuzZzZz/LuaN1aoAgent" target="_blank" rel="noopener noreferrer">LuaN1aoAgent</a>{locale === "zh-CN" ? " 改造而成。" : "."}</footer>
    </div>
  );
}

function LoginForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: AuthScreenProps["onLogin"] }) {
  const { t } = useLanguage();
  return (
    <Form layout="vertical" requiredMark={false} disabled={submitting} onFinish={(values) => void onSubmit(values).catch(() => undefined)}>
      <Form.Item label={t("auth.username")} name="username" rules={[{ required: true, message: t("auth.usernameRequired") }]}>
        <Input autoComplete="username" prefix={<UserRound size={16} />} placeholder="username" />
      </Form.Item>
      <Form.Item label={t("auth.password")} name="password" rules={[{ required: true, message: t("auth.passwordRequired") }]}>
        <Input.Password autoComplete="current-password" prefix={<LockKeyhole size={16} />} placeholder={t("auth.passwordPlaceholder")} />
      </Form.Item>
      <Button block type="primary" htmlType="submit" loading={submitting}>{t("auth.loginWorkbench")}</Button>
    </Form>
  );
}

function RegisterForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: AuthScreenProps["onRegister"] }) {
  const { t } = useLanguage();
  return (
    <Form layout="vertical" requiredMark={false} disabled={submitting} onFinish={(values) => void onSubmit(values).catch(() => undefined)}>
      <Form.Item label={t("auth.displayName")} name="displayName" rules={[{ required: true, message: t("auth.displayNameRequired") }, { min: 2, max: 40 }]}>
        <Input autoComplete="name" prefix={<UserRound size={16} />} placeholder={t("auth.displayNamePlaceholder")} />
      </Form.Item>
      <Form.Item label={t("auth.username")} name="username" rules={[{ required: true }, { pattern: /^[a-zA-Z0-9_.-]{3,32}$/, message: t("auth.usernamePattern") }]}>
        <Input autoComplete="username" prefix={<UserRound size={16} />} placeholder="analyst" />
      </Form.Item>
      <Form.Item label={t("auth.password")} name="password" rules={[{ required: true }, { min: 8, max: 128, message: t("auth.passwordLength") }]}>
        <Input.Password autoComplete="new-password" prefix={<LockKeyhole size={16} />} placeholder={t("auth.passwordMinPlaceholder")} />
      </Form.Item>
      <Form.Item label={t("auth.confirmPassword")} name="confirmPassword" dependencies={["password"]} rules={[
        { required: true, message: t("auth.confirmPasswordRequired") },
        ({ getFieldValue }) => ({ validator: (_, value) => !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error(t("auth.passwordMismatch"))) })
      ]}>
        <Input.Password autoComplete="new-password" prefix={<LockKeyhole size={16} />} placeholder={t("auth.confirmPasswordPlaceholder")} />
      </Form.Item>
      <Button block type="primary" htmlType="submit" loading={submitting}>{t("auth.createAccount")}</Button>
    </Form>
  );
}
