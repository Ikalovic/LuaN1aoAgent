import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Select, Spin, Switch, Table, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import { RefreshCw, Search } from "lucide-react";
import { fetchSkills, setSkillEnabled } from "../api";
import { useLanguage } from "../language";
import type { AuthUser, RegisteredSkill, SkillRegistrySnapshot } from "../types";

type SkillStatusFilter = "all" | "enabled" | "disabled" | "invalid";

export function SkillsView({ user }: { user: AuthUser }) {
  const { t } = useLanguage();
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
      title: t("skills.columnDescription"),
      dataIndex: "description",
      key: "description",
      render: (description: string) => <span className="skill-description">{description}</span>
    },
    {
      title: t("skills.columnValidity"),
      key: "valid",
      width: 110,
      render: (_, skill) => <Tag color={skill.valid ? "green" : "red"}>{skill.valid ? t("skills.valid") : t("skills.filterInvalid")}</Tag>
    },
    {
      title: t("skills.columnModelInvocation"),
      key: "modelInvocable",
      width: 120,
      render: (_, skill) => <Tag color={skill.modelInvocable ? "blue" : "default"}>{skill.modelInvocable ? t("skills.modelInvocable") : t("skills.notInvocable")}</Tag>
    },
    {
      title: t("skills.columnEnabled"),
      key: "enabled",
      width: 88,
      align: "center",
      render: (_, skill) => {
        const reason = user.role !== "admin"
          ? t("skills.operatorRequired")
          : !skill.valid
            ? t("skills.invalidState")
            : !skill.modelInvocable
              ? t("skills.notInvocable")
              : undefined;
        return (
          <Tooltip title={reason}>
            <span>
              <Switch
                aria-label={skill.name}
                checked={skill.enabled}
                disabled={Boolean(reason) || mutating === skill.name}
                loading={mutating === skill.name}
                onChange={(enabled) => void changeState(skill, enabled)}
              />
            </span>
          </Tooltip>
        );
      }
    }
  ];

  return (
    <div className="skills-view">
      <div className="skills-summary">
        <span>{t("skills.total", { value: skills.length })}</span>
        <span>{t("skills.enabled", { value: skills.filter((skill) => skill.enabled).length })}</span>
        <span>{t("skills.invalid", { value: skills.filter((skill) => !skill.valid).length })}</span>
        <span>{t("skills.diagnostics", { value: snapshot?.diagnostics.length ?? 0 })}</span>
      </div>
      <div className="skills-toolbar">
        <div>
          <Typography.Title level={5}>Skills</Typography.Title>
          <span>{t("skills.description")}</span>
        </div>
        <div className="skills-toolbar-controls">
          <Input
            allowClear
            prefix={<Search size={15} />}
            placeholder={t("skills.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select<SkillStatusFilter>
            aria-label={t("skills.filterLabel")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: t("skills.filterAll") },
              { value: "enabled", label: t("skills.filterEnabled") },
              { value: "disabled", label: t("skills.filterDisabled") },
              { value: "invalid", label: t("skills.filterInvalid") }
            ]}
          />
          <Button icon={<RefreshCw size={15} />} loading={loading} onClick={() => void load()}>{t("skills.refresh")}</Button>
        </div>
      </div>
      {error ? <Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => void load()}>{t("skills.retry")}</Button>} /> : null}
      {snapshot?.diagnostics.length ? (
        <Alert
          className="skills-diagnostics"
          type="warning"
          showIcon
          title={t("skills.registryDiagnostics", { value: snapshot.diagnostics.length })}
          description={snapshot.diagnostics.map((diagnostic) => <div key={`${diagnostic.code}:${diagnostic.path ?? diagnostic.skillName ?? diagnostic.message}`}>{diagnostic.message}</div>)}
        />
      ) : null}
      {loading && !snapshot ? <div className="skills-loading"><Spin /></div> : !skills.length ? (
        <Empty description={t("skills.empty")} />
      ) : (
        <Table<RegisteredSkill>
          className="skills-table"
          columns={columns}
          dataSource={visible}
          rowKey="name"
          pagination={false}
          size="small"
          scroll={{ x: 780 }}
          locale={{ emptyText: t("skills.noMatches") }}
        />
      )}
      {user.role !== "admin" ? <span className="skills-readonly-note">{t("skills.readOnly")}</span> : null}
    </div>
  );
}
