# 青玄 自动渗透agent：美术素材交付

日期：2026-09-15。本轮已通过用户指定的 CodeRelay `/v1/chat/completions` 接口，请求 `gpt-image-2.5-flare` 生成素材。共 7 次生成请求、返回 8 张原图，选用 6 张，导出 23 个网页资源。未使用内置 image_gen，也未使用其他模型替代。模型名称依据请求与网关响应记录，不把第三方网关视作官方原生接口。

V3 更新：用户选择平面底图方向，并在 `/home/ika/temp/qingxuan_background_4k.png` 提供新图。已验证为 3840×2160，完整复制为 `qingxuan-background-flat-user-4k.png`，作为当前大屏 V3 背景。新增 4 个发布文件，该阶段清单共 31 项；V1、V2 和其他素材保留。没有调用图片生成接口，不改动画面，只进行缩小和格式导出。V3 WebP 体积为 1080p 21,290 字节、4K 62,510 字节。

首页更新：B 风格首页复用现有品牌与登录背景，新增两张 1920×1080 产品截图的无损 WebP，当前清单共 33 项。截图来自浏览器专用 `lab.example` 演示数据，不含真实运行数据；不是 AI 绘制的界面，也未裁切或放大。工作台截图 53,118 字节，大屏截图 319,930 字节。首页有明确的演示数据说明，本轮没有新增图片生成请求。

[打开全部素材预览](assets/qingxuan-art-preview.html) · [完整提示词及请求参数](assets/qingxuan-generation-prompts.json) · [尺寸、来源与 SHA-256 清单](assets/qingxuan-art-manifest.json)

## 交付清单

| ID | 已交付内容 | 发布位置 |
| --- | --- | --- |
| QX-BRAND-01 | 同一品牌轮廓的深/浅背景版，各 128/256px；通用 256px 透明 PNG | `web/public/brand/qingxuan-symbol*.png` |
| QX-BRAND-02 | 32/48px favicon、16/32/48px 多帧 ICO、180px Apple Touch、192/512px 图标 | `web/public/brand/` |
| QX-AUTH-01 | 1600×1000 登录背景，WebP 与 PNG | `web/public/art/login-surface-dark.*` |
| QX-EMPTY-01 | 384×288 透明空状态图，WebP 与 PNG | `web/public/art/empty-run.*` |
| QX-WALL-01 | 当前 V3 平面底图：1920×1080、3840×2160，各 WebP 与 PNG；V1、V2 保留 | `web/public/art/wallboard-surface-v3-1080.*`、`wallboard-surface-v3-4k.*` |
| QX-WALL-02 | 1920×160 透明机械页头两翼，中央 40% 完全透明 | `web/public/art/wallboard-header-rail.*` |
| QX-WALL-03 | 1024×1024 可重复平铺的金属地台纹理 | `web/public/art/wallboard-deck-albedo.*` |
| QX-HOME-01 | 1920×1080 工作台产品截图，无损 WebP | `web/public/art/home-workbench.webp` |
| QX-HOME-02 | 1920×1080 态势大屏产品截图，无损 WebP | `web/public/art/home-wallboard.webp` |

当前业务大屏已接入 V3 底图，保留中央三维拓扑和外围平面图表；预览页仍是独立静态素材审阅文件。品牌文字由 HTML 排版，不是图片中的 AI 汉字。功能按钮使用 Lucide。

## 原图与派生

早期网关没有严格返回请求尺寸，旧版大屏源图仅 **1672×941**，不带版本号的 4K 文件仍是放大派生。V2、V3 使用用户提供的 **3840×2160** 文件：4K 仅同尺寸编码，1080p 向下采样，不进行放大。可确认文件像素尺寸，但不能仅凭 PNG 判定外部生成工具是否曾放大；不声称验证了其生成过程或所用模型。

选用的原始 PNG 均保存在当前工作区 `output/imagegen/masters/`，该目录依照仓库既有规则不跟踪到 Git：

| 源文件 | 实际尺寸 / 通道 | 生产处理 |
| --- | --- | --- |
| `qingxuan-symbol.png` | 1254×1254，RGBA | 使用原图 alpha 轮廓，移除 alpha <=8 的几乎不可见杂点；同轮廓填充主题色、居中留白并缩小 |
| `login-surface-dark.png` | 1277×1231，RGB | 以右下为锚点裁切为 16:10，再派生 1600×1000；不是原生 2560×1600 母版 |
| `empty-run.png` | 1254×1254，RGBA | 裁出可见主体，放入 1024×768 透明画布，主体占约 60%，派生 384×288 |
| `qingxuan-background-user-4k.png` | 3840×2160，RGB | V2 舱室背景保留，不再默认使用 |
| `qingxuan-background-flat-user-4k.png` | 3840×2160，RGB | 当前 V3 平面底图；用户源文件的完整副本，4K 同尺寸导出、1080p 缩小，不裁切或重绘 |
| `wallboard-surface-sized.png` | 1672×941，RGB | 旧版保留；微调比例后放大派生 1080p/4K，当前预览不再默认使用 |
| `wallboard-header-rail-a.png` | 2116×743，RGBA | 选用较干净的两翼版本；提取原左右翼，等比缩小并分开放入 1920×160 透明画布，不拉伸翼片 |
| `wallboard-deck-albedo.png` | 1254×1254，RGB | 原始输出存在接缝亮度差，采用原纹理的 2×2 镜像排列，形成边缘像素一致的 1024px 平铺纹理 |
| `home-workbench-fixture.png` | 1920×1080，RGB | 实际产品的浏览器演示数据截图；同尺寸无损 WebP，不裁切或重绘 |
| `home-wallboard-fixture.png` | 1920×1080，RGB | 实际大屏的浏览器演示数据截图；同尺寸无损 WebP，不裁切或重绘 |

未选用的首张 4:3 大屏背景和第二张较强光晕页头也保留在原图目录，未发布。加工后的 1024px 深浅 Logo、1024×768 空状态和 3840×320 页头位于 `output/imagegen/`。这些加工件不冒充模型原始输出。

## 验证与使用

- 已实际检查所有选用原图，并检查桌面 1440px 与移动端 390px 的浏览器素材预览；图片正常加载，无横向溢出。
- 品牌两版共用 alpha，24/32/48px 轮廓可辨认；透明素材不是棋盘格背景。页头中央 40% 的 alpha 全为 0，品牌文字可单独排版。
- 导出清单记录尺寸、文件体积、来源尺寸、透明通道、加工方式与 SHA-256。优先加载 WebP，PNG 只作兼容回退；不让大屏 4K PNG 成为常规首屏资源。
- 地台 PNG 的左右/上下边缘 RGB 差为 0；WebP 压缩可能引入微小像素差，需结合实际材质和观看距离判断。纹理不是法线图或粗糙度图，不把同一文件错误绑定到多个材质通道。
- 当前 V3 源文件为 3840×2160。已检查接入后的 1080p、4K 全屏与手机截图、资源选择和中央 Canvas 非背景像素，保留原有图表和三维场景；未新增长期性能测试。早期 V2 的舱室及地板透视不再用于当前页面。
- 首页截图记录原图 SHA-256、浏览器截图来源与 `contains_live_runtime_data: false`；已检查首页中的桌面、手机与 4K 展示和标签切换，并验证全部 33 项清单的文件体积与 SHA-256。

V3 本轮更新背景资源、引用、素材预览和制作记录，完成前端构建及基础浏览器检查；未修改业务数据逻辑、API、权限或运行行为，也未重跑完整应用测试。

## 可复现导出

安装 Pillow 后可执行：

```bash
python scripts/prepare-qingxuan-art.py
```

仅导出新的 V3 背景、保留其他素材时：

```bash
python scripts/prepare-qingxuan-art.py --flat-wallboard-only
```

仅导出首页产品截图、保留其他素材时：

```bash
python scripts/prepare-qingxuan-art.py --homepage-only
```

该脚本不调用网络、不生成新图、不包含密钥，仅从上述本地原图进行裁切、透明边缘整理、主题色派生、缩放和格式导出；首页截图仅进行同尺寸格式导出。重跑只允许覆盖与现有清单 SHA-256 一致的已生成文件，遇到用户修改或未知已有文件会拒绝覆盖。完整原图需在复制工作区时一并备份；仅克隆 Git 仓库可取得发布资源，但不能凭空还原原图。

## 凭据处理

授权值仅通过当前交互 shell 的静默输入与 curl 标准输入配置传递，没有写入提示词、导出脚本、响应记录、网页、Git 文件或图片。下载网关返回的图片链接时未转发 Authorization；生成完成后已清除变量并关闭 shell。聊天中出现过的密钥建议后续在服务商处轮换。
