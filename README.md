# dsh-spec-kb

把本地标准 `spec-kb` 知识库挂载进 DeepSeek Harness，让智能体在回答知识库覆盖的问题时**先查规范、带引用作答**。

- **原地挂载**：直接读知识库目录（`manifest.json` + `entries.jsonl` + `sections/`），不复制、不导入、不转换；知识库重建后无需重新导入。
- **结构化检索**：按 `kind / module / name / query` 检索；需求、API、配置参数、术语、章节分开识别，而不是把 JSONL 当文本切块。
- **可追溯引用**：每条命中带 `kb_id · 文档 · §章节 · p.页码`，需求记录额外带需求 ID。
- **需求追溯**：`spec_kb_trace` 走 `upstream` 关系，向上找它精炼自哪些需求、向下找哪些需求精炼它。
- **合规发现**：`spec_kb_compliance` 查厂商手册里的偏离 / 不支持 / 限制。
- **证据包**：`spec_kb_brief` 为一个分析问题一次性收齐需求、API、配置、合规条目与相关章节，便于“让知识库参与分析”。
- **优先检索**：插件注入一段 system-prompt 指导（可用 `guidance: false` 关闭），要求模型在这类问题上先查库、引用出处、查不到就明说，禁止编造需求 ID / API 签名。

## 安装

本地目录安装：**插件 → Add plugin → 选择本目录**（或 `dsh plugin add <绝对路径>`），然后启用。

要求：DSH `>=0.2.2-rc.5 <0.3.0`，Node `>=22`。

## 设置界面（选择路径）

启用后打开 **设置 → 规范知识库**（Settings 左栏新增一项）：

- 列出当前生效的路径、已加载的知识库（kb_id、版本、记录数、模块数、重复 id 数）；
- **添加 / 移除路径**，支持输入绝对路径，或点 **浏览…** 在页面内逐级选择目录（会标出哪些目录是知识库）；
- **保存** 写入 `$DSH_HOME/spec-kb/settings.json`，下一次工具调用立即使用新路径，**不需要改 profile、不需要重启**；
- **恢复默认** 删除该文件，回到 bundle patch 里的默认路径。

路径优先级：`$DSH_HOME/spec-kb/settings.json`（设置页保存）> `cordis.patch.yml` 的 `config.paths`（bundle 默认）。

设置页背后的接口（同源，仅供本机 UI 使用）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/spec-kb/status` | 生效路径 + 已加载库 + 问题列表 |
| POST | `/api/spec-kb/paths` | 保存路径列表（先校验存在且能找到知识库） |
| POST | `/api/spec-kb/reset` | 删除覆盖，恢复 bundle 默认 |
| GET | `/api/spec-kb/browse?path=` | 列出目录，标出知识库目录 |

> 客户端半部（设置页）由 DSH 在启动时从包的 `./client` 加载；**改动插件代码后需要重启 Desktop** 才会装载新版本，设置页本身在启用后首次启动即出现。

## 配置

`cordis.patch.yml` 里的行：

```yaml
- id: spec-kb
  name: 'dsh-spec-kb'
  config:
    paths:
      - 'F:/MyProject/spec-kb'          # 父目录：自动发现其下所有知识库
      # - 'F:/MyProject/spec-kb/autosar-spec-kb'   # 也可以直接写单个库
    guidance: true                       # 注入“优先查知识库”的提示
    maxResults: 8
    maxBodyChars: 6000
    loadOnStart: false                   # true = 启动即建索引
```

`paths` 支持两种写法：知识库目录本身，或一个“直接子目录是知识库”的父目录。索引在第一次调用工具时构建（AUTOSAR 52k 条实测约 0.6 秒），之后常驻。

`spec_kb_trace` 解析上游需求时，若目标不在 requirement 记录里（AUTOSAR 库里 SRS 需求常以 `[SRS_Mem_00041] …` 的章节形式存在），会回退到“提到该 ID 的记录”，并在结果里标注 `via: "mention"` 与该章节的引用。

## 工具

| 工具 | 用途 |
|---|---|
| `spec_kb_info` | 已挂载的库：kb_id、版本、计数、模块、记录类型、索引健康度 |
| `spec_kb_search` | 按文本 / 模块 / 类型 / 精确名检索，返回带引用的精简命中 |
| `spec_kb_get` | 取一条完整记录（字段、章节、页码、来源文档、上游需求、正文） |
| `spec_kb_trace` | 需求追溯：上游精炼自哪些需求、下游有哪些需求精炼它 |
| `spec_kb_section` | 读章节全文（按模块 + 章节号 / 标题子串） |
| `spec_kb_compliance` | 厂商合规发现：deviation / unsupported / limit |
| `spec_kb_brief` | 为分析问题组装证据包（需求+API+配置+合规+章节，全部带引用） |
| `spec_kb_validate` | 结构校验：计数、id 唯一性、前缀、模块覆盖，可选深度统计 chunks/sections |

模块名支持中文别名：`诊断`→Dcm、`存储`→NvM、`运行时`→Rte、`标定`→Xcp 等。

## 质量门

`spec_kb_validate` 会把知识库自身的结构问题报出来（例如 id 重复、计数不一致、模块不匹配）。建议在信任一个库或重建之后先跑一次；`deep: true` 会额外核对 `chunks.jsonl` 与 `sections/` 的行数。

## 自测

```powershell
node test\selftest.mjs   # 核心读取层：发现/加载/检索/取记录/追溯/章节/合规/证据包/校验
node test\web.test.mjs   # 设置页 API：状态、保存、重置、目录浏览（真实 HTTP + 临时 DSH_HOME）
node test\client.test.mjs # 客户端模块：加载、slot 注册、首屏渲染（假 React + 假 ctx，无需浏览器）
```

## 限制

- 检索是**关键词计分**（名称/模块/摘要/标题），不是语义向量检索；需要语义召回时对 `chunks.jsonl` 另建索引。
- 索引常驻内存：52k 条记录的 AUTOSAR 库约 150–250 MB；`loadOnStart: false` 可避免未使用会话的占用。
- 正文按 `maxBodyChars` 截断并标记 `bodyTruncated`；需要全文时用 `spec_kb_section`。
- 只读：插件不修改知识库。
- 检索到的内容会进入模型请求，涉密规范请自行评估外发范围。
