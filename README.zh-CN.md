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
# 从 npm 安装
dsh plugin --profile web add @pzqian123/dsh-tool-vision

# 从 GitHub 安装（无构建步骤，不需要 allowBuilds）
dsh plugin --profile web add github:pzqian123/dsh-tool-vision

# 从本地 tarball 安装
npm pack
dsh plugin --profile web add .\pzqian123-dsh-tool-vision-0.1.2.tgz
```

> **装完后需要重启 `dsh web`（或该 profile 的进程）** —— bundle 列表在启动时读取。

## 配置

配置分**三层**，全部写在你自己的文件里——插件包不携带任何默认值，未配置视觉路由前工具会拒绝调用。

### 第 1 层 — 视觉路由（端点 + 模型）：`settings.yaml`

路由注册在 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.<名字>` 下（也可用下面的 Web 模型设置页完成）。

**目录内置路由** — pi-ai 内置目录认识的 provider（如 `xiaomi`、`openai`、`anthropic`）只需填密钥引用名，端点和模型清单自动来自内置目录：

```yaml
llm-pi-ai:
  providers:
    xiaomi:
      apiKeyEnv: XIAOMI_API_KEY
```

**自定义 OpenAI 兼容端点** — 手写路由、协议、端点和模型清单。视觉模型的 `input` **必须包含 `image`**，否则工具的能力校验会在图片字节离开本机前直接拒绝调用：

```yaml
llm-pi-ai:
  providers:
    my-vision:
      displayName: My Vision Gateway
      apiKeyEnv: MY_VISION_API_KEY
      api: openai-completions
      baseURL: https://gateway.example.com/v1
      models:
        - id: vision-1
          name: Vision Model 1
          contextWindow: 131072
          maxTokens: 8192
          input: [text, image]      # ← 视觉模型必须有
```

### 第 2 层 — API key：`~/.dsh/.credentials.yaml`（或环境变量）

密钥由凭据服务存储，**绝不写进 `settings.yaml`**。第 1 层的 `apiKeyEnv` 引用就是密钥的名字：

```yaml
MY_VISION_API_KEY: sk-你的密钥
```

…或者不写文件，直接导出同名环境变量。

### 第 3 层 — 让插件指向该路由：profile 的 `cordis.patch.yml`

在 profile 的用户补丁层（如 `~/.dsh/profiles/web/cordis.patch.yml`）把视觉路由写进 `tool-vision` 行的 config：

```yaml
- id: tool-vision
  config:
    provider: my-vision        # 第 1 层的路由名
    model: vision-1            # 第 1 层的模型 id
    # maxTokens: 1024          # 可选：视觉模型最大输出 token 数（默认 1024）
    # timeoutMs: 120000        # 可选：单次视觉调用总超时毫秒数（默认 120000）
```

配置通过 HMR 热生效，改完无需重启。

### 推荐做法：用 Web 模型设置页

设置 → 模型页可以用表单完成第 1、2 层，比手写 YAML 更省事：

- 选目录内置 provider，只填一个 **API key** 输入框——页面通过凭据服务**只写**存储，并自动为你记录 `apiKeyEnv` 引用（派生名为 `<路由名>_API_KEY`）。
- **Add a custom provider** 卡片：填 Provider ID（必须以小写字母开头）、端点、协议、至少一个模型——也可以点 **Fetch available models** 直接从端点拉取模型列表。
- 注意：页面不编辑模型的 `input` 字段；自定义视觉模型需要在 `settings.yaml` 里补 `input: [text, image]`。

## 小提示

- **配置可以让 agent 干**：不用手改 YAML。在任意 DSH 会话里直接说："安装 dsh-tool-vision，并配置成 xiaomi/mimo-v2.5"（或你有的任何 provider/模型）。agent 会执行 `dsh plugin add`、写入 `tool-vision` 行、并通过凭据服务保存 API key——把 key 在同一句话里告诉它即可，它会写进 `~/.dsh/.credentials.yaml`，不会留在聊天记录里。
- **安装也可以让 agent 干**：让 agent 按上面的命令执行即可。唯一需要你手动做的是**重启 `dsh web`**（agent 运行在同一个进程里，重启不了自己）；安装/卸载后都需要重启。
- **改配置免重启**：`tool-vision` 行的配置走 HMR 热生效；只有安装/卸载需要重启。
- **直接说"读这张图"就行**：不需要手动调工具，主模型需要看图时自己会选 `read_image_vision`。
- **从小图开始**：先用小图测试（附件上限默认 5MB）；如果视觉模型回答被截断，让它用更窄的 prompt 或调大 `maxTokens`。
- **密钥别写进 settings.yaml**：密钥在 `~/.dsh/.credentials.yaml`（或环境变量），provider 配置里的 `apiKeyEnv` 只是引用它的名字。

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
├── README.md
└── README.zh-CN.md
```

本地迭代：

```powershell
npm pack
dsh plugin --profile web remove @pzqian123/dsh-tool-vision
dsh plugin --profile web add .\pzqian123-dsh-tool-vision-0.1.2.tgz
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
