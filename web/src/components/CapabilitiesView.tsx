import { Tabs } from "antd";
import { useLanguage } from "../language";
import type { AuthUser, CapabilityTab } from "../types";
import { AgentsPanel } from "./AgentsPanel";
import { McpView } from "./McpView";
import { SkillsView } from "./SkillsView";

/**
 * Unified capabilities page: Skills, MCP servers and Specialist Agents in one
 * navigation entry. The three panels keep their own components and data flow;
 * this container only owns tab selection.
 */
export function CapabilitiesView({ user, tab, onTabChange }: {
  user: AuthUser;
  tab: CapabilityTab;
  onTabChange: (tab: CapabilityTab) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="capabilities-view">
      <Tabs
        activeKey={tab}
        onChange={(key) => onTabChange(key as CapabilityTab)}
        destroyOnHidden={false}
        items={[
          { key: "skills", label: t("capabilities.tabSkills"), children: <SkillsView user={user} /> },
          { key: "mcp", label: t("capabilities.tabMcp"), children: <McpView user={user} /> },
          { key: "agents", label: t("capabilities.tabAgents"), children: <AgentsPanel user={user} /> }
        ]}
      />
    </div>
  );
}
