import { useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Tooltip } from "antd";
import { ArrowRight, ArrowUpRight, ImageOff, Languages, Monitor, Network, ScanLine, Workflow } from "lucide-react";
import { useLanguage } from "../language";
import "../styles/homepage.css";

interface HomePageProps {
  authenticated: boolean;
  workbenchUrl: string;
  wallboardUrl: string;
  loginUrl: string;
  onNavigate: (href: string) => void;
}

const productViews = ["workbench", "wallboard"] as const;
type ProductView = typeof productViews[number];

const copy = {
  "zh-CN": {
    home: "青玄首页",
    navigation: "主导航",
    workbench: "工作台",
    wallboard: "态势大屏",
    login: "登录",
    enter: "进入工作台",
    product: "自动渗透",
    intro: "以自主规划与多智能体协作，贯通资产发现、验证与证据追溯。",
    planning: "自主规划",
    assets: "资产感知",
    evidence: "证据追溯",
    overview: "资产与证据，串起执行全程",
    previews: "产品画面",
    previewCaption: "产品界面截图，使用本地演示数据。",
    workbenchAlt: "青玄工作台，展示资产拓扑、近期发现、任务状态与事件活动",
    wallboardAlt: "青玄态势大屏，展示任务态势、资产关联与执行活动",
    imageUnavailable: "暂时无法加载画面",
    creditBefore: "本项目基于 ",
    creditAfter: " 改造而成。"
  },
  "en-US": {
    home: "Qingxuan home",
    navigation: "Main navigation",
    workbench: "Workbench",
    wallboard: "Wallboard",
    login: "Log in",
    enter: "Enter workbench",
    product: "Autonomous pentesting",
    intro: "Autonomous planning and multi-agent collaboration connect asset discovery, validation, and evidence.",
    planning: "Planning",
    assets: "Asset awareness",
    evidence: "Evidence trails",
    overview: "Assets and evidence, throughout every run",
    previews: "Product views",
    previewCaption: "Product screenshots with local demo data.",
    workbenchAlt: "Qingxuan workbench showing asset topology, recent findings, task status, and activity",
    wallboardAlt: "Qingxuan wallboard showing task status, connected assets, and execution activity",
    imageUnavailable: "This view could not be loaded",
    creditBefore: "This project is adapted from ",
    creditAfter: "."
  }
};

export function HomePage({ authenticated, workbenchUrl, wallboardUrl, loginUrl, onNavigate }: HomePageProps) {
  const { locale, t, toggleLocale } = useLanguage();
  const text = copy[locale];
  const [product, setProduct] = useState<ProductView>("workbench");
  const [failedImages, setFailedImages] = useState<Partial<Record<ProductView, boolean>>>({});
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const languageLabel = locale === "zh-CN" ? t("language.switchToEnglish") : t("language.switchToChinese");
  const productUrl = product === "workbench" ? workbenchUrl : wallboardUrl;

  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(event.currentTarget.getAttribute("href")!);
  };

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % productViews.length;
    else if (event.key === "ArrowLeft") next = (index + productViews.length - 1) % productViews.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = productViews.length - 1;
    else return;
    event.preventDefault();
    setProduct(productViews[next]);
    tabs.current[next]?.focus();
  };

  return (
    <div className="qx-home" lang={locale}>
      <div className="qx-home-stage">
        <img className="qx-home-backdrop" src="/art/login-surface-dark.webp" alt="" fetchPriority="high" />
        <header className="qx-home-nav">
          <a className="qx-home-brand" href="/" onClick={navigate} aria-label={text.home}>
            <img src="/brand/qingxuan-symbol-on-dark.png" width="40" height="40" alt="" />
            <span>青玄</span>
          </a>
          <nav className="qx-home-links" aria-label={text.navigation}>
            <a href={workbenchUrl} onClick={navigate}>{text.workbench}</a>
            <a href={wallboardUrl} onClick={navigate}>{text.wallboard}<ArrowUpRight size={15} aria-hidden="true" /></a>
            <a href={authenticated ? workbenchUrl : loginUrl} onClick={navigate}>{authenticated ? text.enter : text.login}</a>
            <Tooltip title={languageLabel}>
              <button className="qx-home-language" type="button" aria-label={languageLabel} onClick={toggleLocale}>
                <Languages size={18} aria-hidden="true" />
              </button>
            </Tooltip>
          </nav>
        </header>

        <section className="qx-home-hero" aria-labelledby={`${id}-title`}>
          <div className="qx-home-copy">
            <img className="qx-home-symbol" src="/brand/qingxuan-symbol-on-dark.png" width="76" height="76" alt="" />
            <h1 id={`${id}-title`}>青玄</h1>
            <p className="qx-home-product-name">{text.product} <span>agent</span></p>
            <p className="qx-home-intro">{text.intro}</p>
            <div className="qx-home-actions">
              <a className="qx-home-action qx-home-action-primary" href={workbenchUrl} onClick={navigate}>
                <span>{text.enter}</span><ArrowRight size={18} aria-hidden="true" />
              </a>
              <a className="qx-home-action" href={wallboardUrl} onClick={navigate}>
                <Monitor size={18} aria-hidden="true" /><span>{text.wallboard}</span>
              </a>
            </div>
            <ul className="qx-home-capabilities">
              <li><Workflow size={18} aria-hidden="true" /><span>{text.planning}</span></li>
              <li><Network size={18} aria-hidden="true" /><span>{text.assets}</span></li>
              <li><ScanLine size={18} aria-hidden="true" /><span>{text.evidence}</span></li>
            </ul>
          </div>
        </section>
      </div>

      <main className="qx-home-overview" aria-labelledby={`${id}-overview`}>
        <div className="qx-home-overview-inner">
          <div className="qx-home-section-heading">
            <div>
              <p className="qx-home-eyebrow">QINGXUAN / WORKSPACE</p>
              <h2 id={`${id}-overview`}>{text.overview}</h2>
            </div>
            <div className="qx-home-tabs" role="tablist" aria-label={text.previews}>
              {productViews.map((view, index) => (
                <button
                  key={view}
                  ref={(node) => { tabs.current[index] = node; }}
                  type="button"
                  role="tab"
                  id={`${id}-${view}`}
                  aria-selected={product === view}
                  aria-controls={`${id}-product`}
                  tabIndex={product === view ? 0 : -1}
                  onClick={() => setProduct(view)}
                  onKeyDown={(event) => moveTab(event, index)}
                >
                  {text[view]}
                </button>
              ))}
            </div>
          </div>
          <div className="qx-home-product-frame" id={`${id}-product`} role="tabpanel" aria-labelledby={`${id}-${product}`} tabIndex={0}>
            {failedImages[product] ? (
              <div className="qx-home-image-fallback">
                <ImageOff size={28} aria-hidden="true" />
                <p>{text.imageUnavailable}</p>
                <a href={productUrl} onClick={navigate}>{text[product]}<ArrowRight size={18} aria-hidden="true" /></a>
              </div>
            ) : (
              <img
                key={product}
                className="qx-home-product-screen"
                src={`/art/home-${product}.webp`}
                alt={product === "workbench" ? text.workbenchAlt : text.wallboardAlt}
                width="1920"
                height="1080"
                loading="lazy"
                decoding="async"
                onError={() => setFailedImages((failed) => ({ ...failed, [product]: true }))}
              />
            )}
          </div>
          <p className="qx-home-product-caption">{text.previewCaption}</p>
        </div>
      </main>

      <footer className="qx-home-attribution">
        <span className="qx-home-footer-name">QINGXUAN</span>
        <p>{text.creditBefore}<a href="https://github.com/SanMuzZzZz/LuaN1aoAgent" target="_blank" rel="noopener noreferrer">LuaN1aoAgent</a>{text.creditAfter}</p>
      </footer>
    </div>
  );
}
