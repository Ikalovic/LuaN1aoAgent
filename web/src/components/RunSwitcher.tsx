import { useMemo, useState } from "react";
import { Button, Empty, Input, Popover, Tooltip } from "antd";
import { ChevronDown, Folder, Play, Search } from "lucide-react";
import { buildSessionTree, type SessionFolderNode } from "../sessions";
import { useLanguage } from "../language";
import type { RuntimeSession } from "../types";

export function RunSwitcher({ runtimeDir, sessions, onChange, onContinue }: { runtimeDir: string; sessions: RuntimeSession[]; onChange: (dir: string) => void; onContinue: (session: RuntimeSession) => void }) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [directory, setDirectory] = useState(runtimeDir);
  const tree = useMemo(() => buildSessionTree(sessions.filter((session) => `${session.name} ${session.runtimeDir} ${session.goal ?? ""}`.toLowerCase().includes(query.toLowerCase()))), [sessions, query]);
  const select = (dir: string) => { onChange(dir); setOpen(false); };
  const rows = (items: RuntimeSession[]) => items.map((session) => <div className="qx-run-row" key={session.runtimeDir}><button type="button" className={runtimeDir === session.runtimeDir ? "selected" : ""} onClick={() => select(session.runtimeDir)}><strong>{session.name}</strong><small>{session.goal || session.runtimeDir}</small><span>{session.running ? (zh ? "运行中" : "Running") : session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "--"}</span></button>{!session.running ? <Tooltip title={zh ? "继续运行" : "Continue run"}><Button icon={<Play size={15} />} aria-label={`${zh ? "继续" : "Continue"} ${session.name}`} onClick={() => { onContinue(session); setOpen(false); }} /></Tooltip> : null}</div>);
  const folder = (item: SessionFolderNode) => <details key={item.path} open><summary><Folder size={14} />{item.name === "__standalone__" ? (zh ? "独立运行" : "Runs") : item.name}<small>{item.sessionCount}</small></summary>{rows(item.sessions)}{item.folders.map(folder)}</details>;
  return <Popover trigger="click" open={open} onOpenChange={(next) => { setOpen(next); if (next) setDirectory(runtimeDir); }} placement="bottomLeft" content={<div className="qx-run-popover"><Input aria-label={zh ? "搜索运行" : "Search runs"} prefix={<Search size={15} />} value={query} onChange={(event) => setQuery(event.target.value)} allowClear /><div className="qx-run-list">{rows(tree.rootSessions)}{tree.standalone ? folder(tree.standalone) : null}{tree.folders.map(folder)}{!tree.rootSessions.length && !tree.standalone && !tree.folders.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}</div><Input aria-label={zh ? "运行目录" : "Runtime directory"} value={directory} onChange={(event) => setDirectory(event.target.value)} onPressEnter={() => select(directory.trim() || ".agent-runtime")} addonAfter={<Button type="text" size="small" onClick={() => select(directory.trim() || ".agent-runtime")}>{zh ? "载入" : "Load"}</Button>} /></div>}><Button className="qx-run-trigger"><span>{sessions.find((session) => session.runtimeDir === runtimeDir)?.name || runtimeDir}</span><ChevronDown size={14} /></Button></Popover>;
}
