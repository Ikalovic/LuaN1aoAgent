# 专精 Agent 能力面与选项权威模型设计

日期：2026-09-16  
状态：已确认设计，等待实施  
关联：`docs/superpowers/specs/2026-09-16-specialist-agent-sdk-design.md`

## 1. 背景与问题

专精 Agent SDK 已落地 `general` 与 `bruteforce` 两个内置 Agent，但暴露了两类缺陷。

**问题一：能力面与安全参数的修改权暴露给可写用户。**
`SpecialistAgentDefinition.options` 是唯一的可配置面，且每一项都可被 `PUT /api/agents/:id/options` 改写，写入全局 `.agents/specialists-state.json`。这带来三个后果：

- 安全参数（`stopOnLockout`、`maxAttemptsPerAccount`、`threads`）可被放宽到作者未预期的取值，一次修改对**所有后续运行永久生效**。
- 能力面（工具组、技能策略、预算）与任务参数混在同一个"可编辑"语义里，UI 无法区分"这是作者的能力决定"与"这是本次任务的参数"。
- 没有"作者固定、运行期由 Planner 在授权区间内取值"这一档，Planner 无法按目标特征调整强度。

**问题二：bruteforce 的通用性不足。**
- 提示词按协议清单（`http-post-form`、`ssh`、`rdp`）组织，隐含"先知道协议再爆破"的前置，无法处理"给我一份材料，你自己判断怎么爆"。
- `skills.allow` 指向 `password-attack` / `default-credentials` / `hydra` / `credential-stuffing`，仓库内**四个技能都不存在**（`.agents/skills/` 只有 `ctf-web`），技能面实际为空。
- Web 表单爆破所需的 CSRF/token 提取、失败信号基线指纹、会话保持、锁定与验证码检测没有进入工作流。
- executor 镜像内**没有 hydra/ffuf/hashcat/john/medusa**，只有 `nmap`（605 个 NSE 脚本，含 `http-form-brute`/`http-brute`/`ssh-brute`/`ftp-brute`/`mysql-brute`/`smb-brute`）、`curl`、`python3`、`openssh-client`、`sshpass`、`chromium`。以 hydra 为中心的提示词描述的是一套镜像里不存在的工具链。

## 2. 目标与非目标

**目标**

1. 建立选项**权威（authority）模型**：作者固定 / Planner 在授权区间内取值 / 用户直接取值三档，Agent 级总开关 + 选项级收紧。
2. 能力面（工具组、技能策略、预算、安全边界）由作者决定，在 Web 能力页只读展示，不可由任何在线角色修改。
3. Planner 能按目标特征选择受控参数，取值被 Runtime 夹紧在作者与用户设定的边界内。
4. bruteforce 成为**材料驱动**的通用爆破 Agent：输入任意材料，自行识别认证面并完成爆破，覆盖 Web 页面账号密码爆破。
5. 补齐 bruteforce 技能面所需的技能包，且技能面与镜像内真实可用的工具链一致。

**非目标**

- 不新增沙箱后端、不改变 scope 校验与工具审批策略。
- 不引入任务级墙钟预算。
- 本轮不向 executor 镜像新增爆破工具（按用户决定：先改提示词与技能，看效果再决定是否加工具）。技能与提示词只描述镜像内确实存在的工具。
- 不允许任何在线角色修改 `author` 权威的选项值——这是本设计的核心约束，不做例外开关。

## 3. 选项权威模型

### 3.1 三档权威

按"可修改程度"排序，`author` 最严、`user` 最松：

```ts
export const SPECIALIST_OPTION_AUTHORITIES = ["author", "planner", "user"] as const;
export type SpecialistOptionAuthority = (typeof SPECIALIST_OPTION_AUTHORITIES)[number];
```

| 权威 | 值来源 | 用户能做什么 | Planner 能做什么 |
|---|---|---|---|
| `author` | 作者声明的 `default` | 不能改，UI 只读 | 不能改，提交值被丢弃并产生诊断 |
| `planner` | Planner 在 `create_tasks.specialistOptions` 中给出 | 只能设**边界**：`number` 设上限，`string-list` 收窄为子集 | 在 `[author.minimum, min(author.maximum, 用户上限)]` 内选具体值 |
| `user` | 用户在能力页填写的值 | 直接生效（夹紧到作者边界） | 不能改，提交值被丢弃并产生诊断 |

`planner` 权威仅对 `number` 与 `string-list` 有意义，理由与语义：

- `number`：用户设定的是**上限**，Planner 在 `[minimum, 上限]` 内取一个具体值；Planner 未给值时回退到 `min(author.default, 上限)`。
- `string-list`：作者给出的 `default` 是授权全集，用户只能收窄为子集，Planner 从有效子集中选择一个或多个元素。
- `boolean` / `enum` / `string` / `text` 不允许声明 `planner` 权威。这些类型的"用户设上限"没有无歧义含义，`defineSpecialist` 在构造期直接报错，避免出现无法在 UI 上诚实表达的语义。

### 3.2 Agent 级总开关与选项级收紧

```ts
export const SPECIALIST_OPTIONS_MODES = ["planner", "user"] as const;
export type SpecialistOptionsMode = (typeof SPECIALIST_OPTIONS_MODES)[number];
```

- `optionsMode`：作者在定义里给出**默认模式**；用户在能力页可以切换；默认值为 `"planner"`（更安全的一侧）。
- 选项级 `authority` 是**收紧**而非等价覆盖。有效权威取两者中更严格的一个：

```
rank = { author: 0, planner: 1, user: 2 }
effective = override !== undefined && rank[override] < rank[master] ? override : master
```

因此 `optionsMode = "user"` 时，被作者标为 `planner` 或 `author` 的选项仍然不能由用户直接填值；`optionsMode = "planner"` 时，被标为 `user` 的选项被收紧回 `planner`。

### 3.3 类型变更

```ts
export type SpecialistOptionAuthorityOverride = "author" | "planner" | "user";

export type SpecialistOptionSpec =
  | { type: "string";  title: string; description?: string; default?: string;
      pattern?: string; maxLength?: number; placeholder?: string;
      authority?: SpecialistOptionAuthorityOverride }
  | { type: "text";    /* 同上 */ }
  | { type: "number";  title: string; description?: string; default?: number;
      minimum?: number; maximum?: number; integer?: boolean;
      authority?: SpecialistOptionAuthorityOverride }
  | { type: "boolean"; /* ... */ }
  | { type: "enum";    /* ... */ }
  | { type: "string-list"; title: string; description?: string; default?: string[];
      maxItems?: number; authority?: SpecialistOptionAuthorityOverride };

export type SpecialistAgentDefinition = {
  // ...
  /** 作者定义的选项默认模式；用户在能力页可切换。 */
  optionsMode?: SpecialistOptionsMode;
  options?: SpecialistOptionSpecMap;
};
```

每个 item 的 `authority` 缺省为 `undefined`，表示"跟随总开关"。

### 3.4 运行时解析

`SpecialistResolution` 增补：

```ts
type SpecialistOptionPolicy = {
  key: string;
  spec: SpecialistOptionSpec;
  /** 有效权威（已按总开关与选项级收紧计算）。 */
  authority: SpecialistOptionAuthority;
  /** 有效边界：author 边界 ∩ 用户边界（仅 planner 权威有意义）。 */
  bounds?: { minimum?: number; maximum?: number; allowed?: string[] };
  /** 作者默认值。 */
  authorDefault?: SpecialistOptionValue;
  /** 用户存储值（planner 权威下解释为边界，user 权威下解释为值）。 */
  userValue?: SpecialistOptionValue;
};

type SpecialistResolution = {
  ok: true;
  // ...
  options: SpecialistOptionValues;                 // 有效值（可直接进提示词）
  optionPolicies: Record<string, SpecialistOptionPolicy>;
};
```

新增纯函数，供 controller 与测试复用：

```ts
export function resolveTaskSpecialistOptions(
  policies: Record<string, SpecialistOptionPolicy>,
  plannerValues: unknown
): { values: SpecialistOptionValues; diagnostics: SpecialistRegistryDiagnostic[] };
```

规则：

- `author`：取 `authorDefault`。Planner 提供了值 → `specialist_option_not_planner_tunable` 诊断并忽略。
- `planner`：Planner 值存在则夹紧进 `bounds`；越界夹紧并记 `specialist_option_clamped`。Planner 未给值 → 取 `clamp(min(authorDefault, userBound))`；用户值同样被夹紧。
- `user`：取用户值（夹紧到作者边界）。Planner 提供了值 → `specialist_option_not_planner_tunable` 诊断并忽略。
- 未知 key → `specialist_option_unknown` 诊断并忽略。

### 3.5 Planner 面

`SpecialistCatalogEntry` 增补**仅 planner 权威项**的紧凑描述，过滤掉 `author` 与 `user` 权威项——能力面与用户参数都不进入 Planner 的可写视野：

```ts
tunableOptions?: Array<{
  key: string;
  type: "number" | "string-list";
  title: string;
  description?: string;
  min?: number;
  max?: number;
  values?: string[];
  current?: SpecialistOptionValue;
  hint: "pick a number within [min,max]" | "pick from values";
}>;
```

`PlannerTaskSpec` 增补：

```ts
specialistOptions?: Record<string, SpecialistOptionValue>;
```

同时落到 `TaskDefinition.specialistOptions`、图节点 `properties.specialistOptions`，并由 `taskNodeToEnvelope` 读回，保证运行期与恢复路径一致。

## 4. 能力面只读

- `RegisteredSpecialist` 的 `enabledGroups`/`disabledGroups`/`deniedTools`/`skillMode`/`budget`/`concurrency` 已经由 `specialistToolGroupScope` 与定义派生，本轮把它们在 UI 上显式标注为**作者固定**，并新增 `optionsMode` 与每项 `authority`/`editable` 字段。
- `setOptions` 拒绝写入 `author` 权威键与未知键（抛 `SpecialistOptionError`），`planner` 权威键的值被夹紧后落盘。
- `setOptionsMode` 校验取值并在落盘前重算全部夹紧。

## 5. bruteforce 重构

### 5.1 材料驱动

`material` 为 `text`、`authority: "user"`（任务目标类参数，允许用户与 Planner 侧的任务输入承载）。Agent 第一步是**材料识别**，而不是选协议：

| 材料形态 | 识别要点 | 首选举措 |
|---|---|---|
| 原始 HTTP 请求报文 | 方法/路径/Host/Cookie/表单或 JSON 体 | 复用报文为模板，补 `username`/`password` 字段 |
| curl 命令 / 登录 URL | 认证端点与字段名 | 归一化为请求模板 |
| 账号或口令候选 | 已知量在哪一侧 | 已知账号求口令 / 已知口令求账号 / 双向 |
| 哈希文件 | 算法与格式 | 离线破解，按哈希类型选策略 |
| 服务 banner / 非 HTTP 目标串 | 服务与认证机制 | `ssh-brute`/`ftp-brute`/`mysql-brute` 等 NSE 或 stdlib 客户端 |

后续步骤（失败信号基线 → 判据指纹 → 策略排序 → 速率与锁定控制 → 命中验证 → 证据与凭据交接）对所有材料形态通用。

### 5.2 工具面

executor 镜像内实际可用：`nmap` + NSE 爆破脚本、`curl`、`python3`（stdlib `ftplib`/`imaplib`/`smtplib`/`http.client`）、`openssh-client` + `sshpass`、`chromium`。提示词与技能只描述这些工具。

工具组策略保持收窄：禁用 `fofa`、`beekeeper`、`network_diagnostics`。

### 5.3 选项集

| key | 类型 | 权威 | 说明 |
|---|---|---|---|
| `material` | text | `user` | 输入材料（任意形态） |
| `materialRef` | string | `user` | 材料 artifact/evidence 引用，Planner 或用户给出 |
| `threads` | number | `planner` | 作者上限 8，默认 4；Planner 只能取更小值 |
| `maxAttemptsPerAccount` | number | `planner` | 作者上限 100，默认 20 |
| `stopOnLockout` | boolean | `author` | 固定 `true`，只读 |
| `authorizedProtocols` | string-list | `author` | 授权协议全集，固定 |

`wordlist` 路径选项被移除：任意宿主路径是能力面/越权面，字典改由 Agent 在当前 workspace 内依据材料构建并记录来源与规模。

### 5.4 技能包

在 `.agents/skills/` 下新增并让 `skills.allow` 与实际文件严格对齐：

- `password-attack`：认证面识别、失败信号基线、喷洒与穷举的取舍、锁定/限速/验证码边界、命中验证与凭据交接。
- `web-login-bruteforce`：Web 表单与 JSON 登录爆破全流程（CSRF/token 提取、会话保持、响应差异指纹、curl/python 实现、`http-form-brute` 用法）。
- `default-credentials`：默认与产品文档凭据的检索与命中判据。
- `credential-stuffing`：已知凭据复用与账号-口令配对纪律。

## 6. 验收

1. 单测：权威解析、总开关与选项级收紧、Planner 值夹紧、`author` 权威不可写、registry 状态迁移、Planner catalog 过滤、web API 只读与夹紧。
2. 既有测试：`general` 路径行为不变。
3. 端到端：Docker 起公开靶场（DVWA / juice-shop），以"给一份材料"的方式驱动 bruteforce Agent 取得命中凭据，并复核证据链。
