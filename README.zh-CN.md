# dsh-tool-vision

[English](./README.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）外挂读图能力的插件：当主模型（如 `deepseek-v4-flash`，本身不支持图像输入）需要读取图片时，它调用插件注册的 `read_image_vision` 工具；插件读取图片文件，把**图片 + 主模型本次按任务构造的 prompt** 发给用户配置的可识图模型（多模态），再把该模型返回的文字描述作为工具结果交回主模型。会话中不会注入任何图片块，纯文本主路由可正常续写。

## 特性

- **零构建步骤**：纯 ESM JavaScript，`lib/` 直接入库——从 GitHub、npm 或 tarball 安装都不需要构建脚本，也无需 pnpm `allowBuilds` 白名单。
- **复用 DSH 自身的 LLM 基础设施**：provider、密钥、重试、代理都走 DSH 常规模型设置（如 `llm-pi-ai.providers.<name>`）。
- **prompt 由主模型按任务决定**：插件没有固定 prompt，每次调用时由主模型决定问什么。
- **能力前置校验**：配置的模型未声明 `image` 输入时直接拒绝，图片字节不会离开本机。
- **附件安全**：图片字节经附件服务校验（magic-byte、大小上限），且绝不进入会话历史。

## 工作原理

```
主模型（无视觉） ──read_image_vision(file_path, prompt)──▶ dsh-tool-vision
                                                              │
                                                              │ 读取文件 → attachments.saveImage（校验/持久化）
                                                              │ llm.stream({provider, model, messages:[图片+prompt]})
                                                              ▼
                                              用户配置的视觉模型（如 xiaomi/mimo-v2.5）
                                                              │
                                                              ▼ 文字描述
主模型 ◀──────────── 工具结果（path / provider / model / description）──┘
```

视觉模型**只看到图片和 prompt**，看不到对话历史——主模型必须把完成任务所需的全部上下文写进 prompt。

## 环境要求

- 已安装 DeepSeek Harness（`dsh` CLI 在 PATH 中）
- 一条**已注册**且模型**声明了 image 输入**的 LLM 路由。内置示例：`xiaomi` 路由的 `mimo-v2.5`（在 Web 模型设置页或 `settings.yaml` 的 `llm-pi-ai.providers.xiaomi` 配置，并设置其 `apiKeyEnv` 对应密钥，如 `XIAOMI_API_KEY`）。

## 安装

任选其一（下面以 `web` profile 为例，其他 profile 请用 `--profile <name>`）：

```powershell
# 从 GitHub 安装（无构建步骤，不需要 allowBuilds）
dsh plugin --profile web add github:<你的用户名>/dsh-tool-vision

# 从 npm 安装（如已发布）
dsh plugin --profile web add dsh-tool-vision

# 从本地 tarball 安装
npm pack
dsh plugin --profile web add .\dsh-tool-vision-0.1.1.tgz
```

> **装完后需要重启 `dsh web`（或该 profile 的进程）** —— bundle 列表在启动时读取。

## 配置

在 profile 的用户补丁层（如 `~/.dsh/profiles/web/cordis.patch.yml`）把视觉路由写进 `tool-vision` 行的 config：

```yaml
- id: tool-vision
  config:
    provider: xiaomi
    model: mimo-v2.5
    # maxTokens: 1024      # 可选：视觉模型最大输出 token 数（默认 1024）
    # timeoutMs: 120000    # 可选：单次视觉调用总超时毫秒数（默认 120000）
```

- `provider`：已注册的 LLM 路由名。内置路由：`deepseek-official`；配置型路由：settings.yaml 里 `llm-pi-ai.providers.<name>` 的名字（Web 模型设置页写入）。
- `model`：该路由下**声明了图像输入**的模型 id。pi-ai 内置目录里 `xiaomi` 的 `mimo-v2.5` 等可识图；自建模型条目需在其 `input` 中声明 `image`。

配置通过 HMR 热生效，改完无需重启。

## 使用

直接让主模型读图即可，例如：

> 读取 D:\images\截图.png，逐字告诉我图中写了什么

模型会调用 `read_image_vision` 并按任务给出 prompt。工具目录中同时存在 harness 自带的 `read_image`（当前路由不支持图像时会拒绝）和本插件的 `read_image_vision`，系统提示会引导模型在无法直接收图时使用后者。

### 工具契约

| | |
| --- | --- |
| `file_path` | PNG/JPEG/WebP/GIF 图片路径，由 DSH 文件系统后端解析 |
| `prompt` | 必填；你对视觉模型的指令（它只看到图片和这个 prompt） |
| 输出 | `{ path, provider, model, prompt, description, truncated }` |

## 隐私说明

图片字节会发送给你在 DSH 模型设置中配置的视觉 provider（同一个 provider/密钥）。会话中的其他内容不会发送。描述以纯文本形式存入会话。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 调用报"read_image_vision is not configured" | 未配置 `tool-vision` 行 config，按上文补 provider/model |
| 报"no adapter registered for provider" | provider 路由未注册：在模型设置页 / settings.yaml 配置 `llm-pi-ai.providers.<name>` |
| 报"does not declare image input" | 目标模型无视觉能力，换可识图模型（其模型条目 `input` 含 `image`） |
| 报"no credential for provider route" | 该 provider 的 `apiKeyEnv` 对应密钥未配置（Web 模型设置页或 `~/.dsh/.credentials.yaml`） |
| 报"exceeds the X-byte attachment limit" | 图片超过附件大小上限（默认 5MB），压缩后再读 |
| 报"extension declares ... but the bytes use a different image format" | 文件扩展名与真实格式不符，改名或转换 |
| 视觉模型返回空/超时 | 检查网络、密钥额度；超时可调大 `timeoutMs`；输出截断可调大 `maxTokens` 或让主模型用更窄的 prompt 重试 |

## 开发

```
dsh-tool-vision/
├── package.json       # 声明 dsh.bundle（bundle 清单）
├── cordis.patch.yml   # 插入 tool-vision 行的补丁层
├── lib/index.js       # 插件实现（纯 ESM，无构建步骤）
└── README.md
```

本地迭代：

```powershell
npm pack
dsh plugin --profile web remove dsh-tool-vision
dsh plugin --profile web add .\dsh-tool-vision-0.1.1.tgz
```

> 注意：pnpm 对本地目录依赖会建符号链接，运行时依赖会从真实路径解析失败，因此始终用 tarball（或 GitHub/npm）安装。

## 配置项一览（Config schema）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `provider` | string | `""` | 视觉模型所在 provider 路由名（必配，否则调用报错） |
| `model` | string | `""` | 视觉模型 id，须声明 image 输入（必配） |
| `maxTokens` | number | 1024 | 视觉模型最大输出 token 数 |
| `timeoutMs` | number | 120000 | 单次视觉调用总超时（毫秒） |

## License

MIT
