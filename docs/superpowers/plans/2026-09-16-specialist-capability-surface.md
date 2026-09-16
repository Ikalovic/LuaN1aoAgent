# 专精 Agent 能力面与选项权威模型实施计划

日期：2026-09-16  
设计：`docs/superpowers/specs/2026-09-16-specialist-capability-surface-design.md`  
状态：待实施

## 目标

按设计文档交付完整纵切：SDK 选项权威模型 + 能力面只读 + Planner 受控取值 + 材料驱动的 bruteforce + 技能包 + 靶场验证。

## 阶段划分

### P0 基线（已完成）

- 环境事实：executor 镜像 `luanniao-executor:latest` 内含 `nmap 7.93`（605 个 NSE 脚本，含 `http-form-brute`/`http-brute`/`ssh-brute`/`ftp-brute`/`mysql-brute`/`smb-brute`）、`curl`、`python3 3.11`（无 `requests`，stdlib 可用）、`openssh-client` + `sshpass`、`chromium`、`jq`；**无** hydra/ffuf/hashcat/john/medusa。
- 技能现状：`.agents/skills/` 仅有 `ctf-web`；bruteforce 的 `skills.allow` 四项全部不存在。
- 靶场：Docker 29.1.3 可用，无 compose 插件，用 `docker run`。

### P1 SDK 权威模型（无行为变更的部分先落地）

修改 `src/specialists/types.ts`：

- 新增 `SPECIALIST_OPTION_AUTHORITIES`、`SpecialistOptionAuthority`、`SPECIALIST_OPTIONS_MODES`、`SpecialistOptionsMode`。
- `SpecialistOptionSpec` 各分支新增 `authority?: SpecialistOptionAuthorityOverride`。
- `SpecialistAgentDefinition` 新增 `optionsMode?: SpecialistOptionsMode`。
- 新增 `SpecialistOptionPolicy`、`SpecialistPlannerTunableOption`。
- `SpecialistResolution.ok` 分支新增 `optionPolicies: Record<string, SpecialistOptionPolicy>`。
- `SpecialistCatalogEntry` 新增 `tunableOptions?`。
- 新增 `effectiveOptionAuthority(master, override)`、`resolveSpecialistOptionPolicies(definition, userValues)`、`resolveTaskSpecialistOptions(policies, plannerValues)`。

修改 `src/specialists/sdk.ts`：

- 校验 `optionsMode` 取值、每项 `authority` 取值、`planner` 权威的类型限制（仅 `number`/`string-list`）。
- `normalizeSpecialistOptions` 增补"按权威过滤"的入口：`author` 键忽略用户值，`planner` 键夹紧为边界。

测试：`test/specialist-sdk.test.ts` 增补权威计算、类型限制、夹紧。

### P2 Registry 与持久层

修改 `src/specialists/registry.ts`：

- `SpecialistStateEntry` 新增 `optionsMode`。
- `toRegistered` 输出每项 `authority`/`editable`/`bounds` 与 `optionsMode`。
- `resolve` 返回 `options`（有效值，用于提示词）与 `optionPolicies`（用于任务级夹紧）。
- `setOptions`：拒绝 `author` 键（`specialist_option_not_editable`）与未知键；`planner` 键夹紧；`user` 键夹紧到作者边界。
- 新增 `setOptionsMode(id, mode)`。
- 状态文件读回时兼容旧格式（无 `optionsMode` → 取作者默认）。

测试：`test/specialist-registry.test.ts` 增补只读拒绝、夹紧、模式持久化、旧状态迁移。

### P3 Planner 链路

修改：

- `src/types.ts`：`PlannerTaskSpec.specialistOptions`、`TaskDefinition.specialistOptions`。
- `src/tools/pi-tools.ts`：`PlannerTaskSpecSchema.specialistOptions`。
- `src/stores/graph-store.ts`：Task 节点 `properties.specialistOptions` 写入与 `taskNodeToEnvelope` 读回。
- `src/controller.ts`：`catalog()` 过滤出 `tunableOptions`；`create_tasks` 校验并落盘 `specialistOptions`；`resolveSpecialistCandidates`/`runEpoch` 用 `resolveTaskSpecialistOptions` 夹紧后交给 Executor。
- `src/prompts.ts`：`PLANNER_SYSTEM_PROMPT` 增补 `specialistOptions` 用法，`available_specialists` 自动带上 `tunableOptions`；`renderExecutorInput`/`renderExecutorResumeInput` 增补"本 Task 生效参数"行。

测试：`test/controller-specialists.test.ts` 增补 Planner 取值夹紧与越权忽略。

### P4 Web 服务端与能力页

修改：

- `src/web-server.ts`：`GET /api/agents` 返回 `optionsMode`/`authority`/`editable`/`bounds`；新增 `POST /api/agents/:id/options-mode`（`operator:mutate`）。
- `web/src/types.ts`、`web/src/api.ts`：同步类型与 API。
- `web/src/components/SpecialistOptionsDrawer.tsx`：`author` 项渲染为只读并标注"作者固定"；`planner` 项渲染为"上限"控件。
- `web/src/components/AgentsPanel.tsx`：新增总开关列（planner 指定 / 用户指定），能力面摘要标注"作者固定"。
- `web/src/language.tsx`：新增文案。

测试：`test/web-server-specialists.test.ts`、`web/src/components/AgentsPanel.test.tsx`。

### P5 bruteforce 重构

修改 `src/specialists/builtin/bruteforce.ts`：

- 提示词改为材料驱动：材料识别 → 失败信号基线 → 判据指纹 → 策略排序 → 速率/锁定控制 → 命中验证 → 证据与凭据交接。
- 工具面：保持禁用 `fofa`/`beekeeper`/`network_diagnostics`；提示词改述镜像内真实工具（nmap NSE、curl、python3 stdlib、sshpass、chromium）。
- 选项集按设计 5.3 重排，移除 `wordlist`/`protocols`。
- `skills.allow` 对齐实际技能文件。

### P6 技能包

新增 `.agents/skills/` 下四个技能：`password-attack`、`web-login-bruteforce`、`default-credentials`、`credential-stuffing`，格式与 `ctf-web/SKILL.md` 一致，内容对齐镜像内真实工具。

### P7 验证

- `npm run build:server`、`npm run build:web`。
- `node --test` 运行新增与受影响的测试文件。
- `npm run test:web`。
- Docker 靶场端到端：起 DVWA 与 juice-shop，构造"一份材料"驱动 bruteforce Agent，复核命中凭据与证据链。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 状态文件语义变化导致既有部署读出错误值 | 读回时按新模式重新归一化与夹紧；缺 `optionsMode` 时取作者默认 |
| Planner 传入越界值导致实际强度超出作者预期 | 夹紧发生在 Runtime 单一入口 `resolveTaskSpecialistOptions`，并写诊断事件 |
| `author` 权威键被旧状态文件携带残留值 | 解析时忽略并产出 `specialist_option_not_editable` 诊断 |
| 技能面与镜像工具链再次脱节 | 技能内容只描述 P0 已核验存在的工具，并在技能内写明核验方式 |
| 端到端验证依赖 LLM 凭据 | 无 `.env` 时先完成单测与靶场可达性验证，再向用户索取凭据 |
