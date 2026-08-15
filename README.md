# dsh-tool-vision

[中文文档](./README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives a text-only model route (e.g. `deepseek-v4-flash`) an image-reading capability by routing the image to a user-configured, vision-capable LLM route.

When the main model needs to see an image, it calls the plugin's `read_image_vision` tool. The plugin reads the image file and sends **the image + a task-specific `prompt`** (written by the main model per task) to the configured vision model, then returns the textual description as the tool result. No image block is ever injected into the session, so the text-only main route keeps working.

## Features

- **Zero build step**: plain ESM JavaScript, `lib/` committed — installs from GitHub, npm, or a tarball with no build scripts, no `allowBuilds` permission needed.
- **Uses DSH's own LLM infrastructure**: providers, credentials, retry, and proxies configured through the normal DSH model settings (e.g. `llm-pi-ai.providers.<name>`).
- **Prompt authored by the main model**: the plugin has no fixed prompt; the main model decides what to ask about the image per task.
- **Capability-checked**: the tool refuses to run unless the configured model declares `image` input, before any bytes leave the machine.
- **Attachment-safe**: image bytes are validated by the attachment service (magic-byte check, size caps) and never enter the conversation history.

## How it works

```
main model (no vision) ──read_image_vision(file_path, prompt)──▶ dsh-tool-vision
                                                                    │
                                                                    │ read file → attachments.saveImage (validate/persist)
                                                                    │ llm.stream({provider, model, messages:[image+prompt]})
                                                                    ▼
                                                     configured vision model (e.g. xiaomi/mimo-v2.5)
                                                                    │
                                                                    ▼ text description
main model ◀──────────── tool result (path / provider / model / description) ──┘
```

The vision model sees **only the image and the prompt** — it has no access to the conversation, so the main model must put everything needed to answer into the `prompt` argument.

## Requirements

- DeepSeek Harness installed (`dsh` CLI on PATH)
- A registered LLM route whose model declares `image` input. Built-in example: the `xiaomi` route with `mimo-v2.5` (configured via the Web Models page or `settings.yaml` → `llm-pi-ai.providers.xiaomi`, with its `apiKeyEnv` credential set, e.g. `XIAOMI_API_KEY`).

## Installation

Choose one — the profile commands below use `web` as an example; pass `--profile <name>` for any other profile.

```powershell
# From GitHub (no build step, so no allowBuilds is required)
dsh plugin --profile web add github:<your-name>/dsh-tool-vision

# From npm (if published)
dsh plugin --profile web add dsh-tool-vision

# From a local tarball
npm pack
dsh plugin --profile web add .\dsh-tool-vision-0.1.1.tgz
```

> **Restart `dsh web` (or the profile's process) after installing** — the bundle list is read at startup.

## Configuration

Add the vision route to the `tool-vision` row in your profile's patch layer (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: tool-vision
  config:
    provider: xiaomi
    model: mimo-v2.5
    # maxTokens: 1024      # optional: vision model max output tokens (default 1024)
    # timeoutMs: 120000    # optional: total timeout per vision call in ms (default 120000)
```

- `provider`: a registered LLM route name. Built-in: `deepseek-official`; configured routes: names under `llm-pi-ai.providers.<name>` in `settings.yaml` (Web Models page).
- `model`: a model id under that route that declares image input. For pi-ai built-in catalogs, e.g. `xiaomi`/`mimo-v2.5`; for custom model entries, its `input` must include `image`.

Config changes take effect via HMR — no restart needed.

## Usage

Just ask the main model to read an image:

> Read D:\images\screenshot.png and tell me, character by character, what text is in it.

The model will call `read_image_vision` with a task-specific prompt. The harness's built-in `read_image` tool coexists in the tool catalog (it refuses when the current route cannot carry images); the system prompt guides the model to prefer `read_image_vision` in that case.

### Tool contract

| | |
| --- | --- |
| `file_path` | path to a PNG/JPEG/WebP/GIF image, resolved by the DSH filesystem backend |
| `prompt` | required; your instruction to the vision model about the image (it sees only the image and this prompt) |
| output | `{ path, provider, model, prompt, description, truncated }` |

## Privacy

The image bytes are sent to the configured vision provider (the same provider/credential you configure in DSH model settings). Nothing else from the session is sent. The description is stored in the session as plain text.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "read_image_vision is not configured" | The `tool-vision` row config is missing provider/model — add it as shown above |
| "no adapter registered for provider" | Provider route not registered — configure `llm-pi-ai.providers.<name>` in settings.yaml / Web Models page |
| "does not declare image input" | The target model has no vision capability — switch to a model whose entry declares `image` input |
| "no credential for provider route" | The provider's `apiKeyEnv` credential is missing — set it on the Web Models page or in `~/.dsh/.credentials.yaml` |
| "exceeds the X-byte attachment limit" | Image larger than the attachment cap (default 5MB) — compress first |
| "extension declares ... but the bytes use a different image format" | Extension does not match the real format — rename or convert |
| Vision model returns empty / times out | Check network and quota; raise `timeoutMs`; raise `maxTokens` or ask the main model to retry with a narrower prompt when truncated |

## Development

```
dsh-tool-vision/
├── package.json       # declares dsh.bundle (bundle manifest)
├── cordis.patch.yml   # the patch layer that inserts the tool-vision row
├── lib/index.js       # the plugin implementation (plain ESM, no build step)
└── README.md
```

Iterate locally:

```powershell
npm pack
dsh plugin --profile web remove dsh-tool-vision
dsh plugin --profile web add .\dsh-tool-vision-0.1.1.tgz
```

> Note: pnpm symlinks local-directory dependencies, which breaks runtime resolution — always install from the tarball (or GitHub/npm) rather than a local path.

## Config schema

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | string | `""` | Vision provider route name (required) |
| `model` | string | `""` | Vision model id, must declare image input (required) |
| `maxTokens` | number | 1024 | Vision model max output tokens |
| `timeoutMs` | number | 120000 | Total timeout per vision call, ms |

## License

MIT
