import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Select, Spin, Switch, Table, Tag, Typography, type TableColumnsType } from "antd";
import { RefreshCw, Search } from "lucide-react";
import { fetchSkills, setSkillEnabled } from "../api";
import type { AuthUser, RegisteredSkill, SkillRegistrySnapshot } from "../types";

type SkillStatusFilter = "all" | "enabled" | "disabled" | "invalid";

export function SkillsView({ user }: { user: AuthUser }) {
  const [snapshot, setSnapshot] = useState<SkillRegistrySnapshot>();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SkillStatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [mutating, setMutating] = useState<string>();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchSkills(signal);
      if (!signal?.aborted) setSnapshot(next);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const skills = snapshot?.skills ?? [];
  const visible = useMemo(() => skills.filter((skill) => {
    const matchesQuery = `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesStatus = status === "all"
      || (status === "enabled" && skill.enabled)
      || (status === "disabled" && !skill.enabled)
      || (status === "invalid" && !skill.valid);
    return matchesQuery && matchesStatus;
  }), [query, skills, status]);
  const changeState = async (skill: RegisteredSkill, enabled: boolean) => {
    setMutating(skill.name);
    setError(undefined);
    try {
      const updated = await setSkillEnabled(skill.name, enabled);
      setSnapshot((current) => current ? {
        ...current,
        skills: current.skills.map((candidate) => candidate.name === updated.name ? updated : candidate)
      } : current);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(undefined);
    }
  };
  const columns: TableColumnsType<RegisteredSkill> = [
    {
      title: "Skill",
      dataIndex: "name",
      key: "name",
      width: 210,
      render: (name: string) => <Typography.Text strong code>{name}</Typography.Text>
    },
    {
      title: "描述",
      dataIndex: "description",
      key: "description",
      render: (description: string) => <span className="skill-description">{description}</span>
    },
    {
      title: "有效性",
      key: "valid",
      width: 110,
      render: (_, skill) => <Tag color={skill.valid ? "green" : "red"}>{skill.valid ? "有效" : "无效"}</Tag>
    },
    {
      title: "模型调用",
      key: "modelInvocable",
      width: 120,
      render: (_, skill) => <Tag color={skill.modelInvocable ? "blue" : "default"}>{skill.modelInvocable ? "可调用" : "不可调用"}</Tag>
    },
    {
      title: "启用",
      key: "enabled",
      width: 88,
      align: "center",
      render: (_, skill) => (
        <Switch
          aria-label={skill.name}
          checked={skill.enabled}
          disabled={user.role !== "admin" || !skill.valid || !skill.modelInvocable || mutating === skill.name}
          loading={mutating === skill.name}
          onChange={(enabled) => void changeState(skill, enabled)}
        />
      )
    }
  ];

  return (
    <div className="skills-view">
      <div className="skills-summary">
        <span>{skills.length} 个 Skill</span>
        <span>{skills.filter((skill) => skill.enabled).length} 个已启用</span>
        <span>{skills.filter((skill) => !skill.valid).length} 个无效</span>
        <span>{snapshot?.diagnostics.length ?? 0} 条诊断</span>
      </div>
      <div className="skills-toolbar">
        <div>
          <Typography.Title level={5}>Skills</Typography.Title>
          <span>检查项目 Skill，并控制是否允许模型在任务中选择。</span>
        </div>
        <div className="skills-toolbar-controls">
          <Input
            allowClear
            prefix={<Search size={15} />}
            placeholder="搜索名称或描述"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select<SkillStatusFilter>
            aria-label="Skill 状态"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "全部状态" },
              { value: "enabled", label: "已启用" },
              { value: "disabled", label: "已停用" },
              { value: "invalid", label: "无效" }
            ]}
          />
          <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void load()}>刷新</Button>
        </div>
      </div>
      {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} /> : null}
      {snapshot?.diagnostics.length ? (
        <Alert
          className="skills-diagnostics"
          type="warning"
          showIcon
          title={`${snapshot.diagnostics.length} 条 Registry 诊断`}
          description={snapshot.diagnostics.map((diagnostic) => <div key={`${diagnostic.code}:${diagnostic.path ?? diagnostic.skillName ?? diagnostic.message}`}>{diagnostic.message}</div>)}
        />
      ) : null}
      {loading && !snapshot ? <div className="skills-loading"><Spin /></div> : !skills.length ? (
        <Empty description=".agents/skills 中没有可用 Skill" />
      ) : (
        <Table<RegisteredSkill>
          className="skills-table"
          columns={columns}
          dataSource={visible}
          rowKey="name"
          pagination={false}
          size="small"
          scroll={{ x: 780 }}
          locale={{ emptyText: "没有符合筛选条件的 Skill" }}
        />
      )}
      {user.role !== "admin" ? <span className="skills-readonly-note">当前账号仅可查看 Skill。</span> : null}
    </div>
  );
}
