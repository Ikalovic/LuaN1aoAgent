import { useLanguage } from "../language";
import { useTheme } from "../ThemeProvider";

export function Brand({ className = "" }: { className?: string }) {
  const { locale } = useLanguage();
  const { mode } = useTheme();
  return <div className={`qingxuan-brand ${className}`.trim()} role="img" aria-label="青玄 Qingxuan">
    <img className="qingxuan-brand-symbol" src={`/brand/qingxuan-symbol-on-${mode}-128.png`} width={44} height={44} alt="" />
    <div className="qingxuan-brand-copy">
      <strong>青玄</strong>
      <span>{locale === "zh-CN" ? "自动渗透agent" : "Autonomous Pentest Agent"}</span>
    </div>
  </div>;
}
