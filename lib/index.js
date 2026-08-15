import { basename, extname } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import { FsError } from "@deepseek-ai/dsh-fs";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";

/**
 * dsh-tool-vision: give a text-only model route (e.g. DeepSeek) an image-reading
 * capability by routing the image to a user-configured, vision-capable LLM route.
 *
 * The plugin registers one model-facing tool, `read_image_vision`. The MAIN
 * model decides what to ask: `prompt` is a REQUIRED tool argument the main
 * model fills per task, and the vision model sees ONLY the image and that
 * prompt (it has no conversation access). The vision route itself is
 * configured on the `tool-vision` composition row (profile cordis.patch.yml)
 * as `provider` + `model`, naming any registered LLM route whose model
 * declares `image` input.
 *
 * The vision description is returned as plain tool-result text; no image block
 * is ever injected into the session (the main route cannot carry images).
 *
 * @module dsh-tool-vision
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-tool-vision";
/** Services required by the vision tool. */
const inject = ["tools", "fs", "systemPrompt", "llm"];

/** Default maximum output tokens for one vision description. */
const DEFAULT_MAX_TOKENS = 1024;
/** Default total timeout for one vision call, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120000;

/** Extensions `read_image_vision` accepts; magic-byte validation at the attachment service stays authoritative. */
const IMAGE_EXTENSIONS = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};

/** Plugin configuration: the vision route plus call caps. There is deliberately NO fixed prompt. */
const Config = z.object({
	provider: z.string().default(""),
	model: z.string().default(""),
	maxTokens: z.number().default(DEFAULT_MAX_TOKENS),
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
});

/** Reject a non-positive-integer config field, mirroring tool-fs validation. */
function assertPositiveInteger(field, value) {
	if (!Number.isInteger(value) || value < 1) throw new Error(`tool-vision: ${field} must be a positive integer`);
}

/** Resolve the configured vision route, or refuse with exact configuration guidance. */
function resolveVisionRoute(config) {
	const provider = config.provider.trim();
	const model = config.model.trim();
	if (provider.length === 0 || model.length === 0) {
		throw new Error(
			"read_image_vision is not configured: set the vision provider and model on the \"tool-vision\" row of the profile's cordis.patch.yml, e.g.\n" +
			"- id: tool-vision\n  config:\n    provider: xiaomi\n    model: mimo-v2.5\n" +
			"The provider must be a registered LLM route whose model declares image input (configure it on the web Models page / settings.yaml `llm-pi-ai.providers.<name>`, with the model's `input` including `image`)."
		);
	}
	return { provider, model };
}

/** Require the configured vision model to declare image input before any bytes leave the machine. */
async function assertImageCapableModel(llm, provider, model, signal) {
	const info = await llm.resolveModelInfo(provider, model, signal);
	if (info.inputModalities === void 0 || !info.inputModalities.includes("image")) {
		throw new Error(
			`cannot read an image through model "${model}" (provider "${provider}"): it does not declare image input; ` +
			"point the tool-vision row at a vision-capable model (its model entry must declare image input)"
		);
	}
}

/** The session workspace cwd for this call, or undefined when none applies (mirrors tool-fs). */
const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
function sessionCwd(exec, requestedPath) {
	const cwd = exec.agent?.session.header.cwd;
	if (cwd === void 0 || !PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath)) return cwd;
	return canonicalPath(cwd);
}

/** Filesystem resolution options for the calling agent's workspace (mirrors tool-fs). */
function sessionResolveOptions(exec, requestedPath) {
	const cwd = sessionCwd(exec, requestedPath);
	return {
		...cwd !== void 0 ? { cwd } : {},
		signal: exec.signal
	};
}

/** Human-readable message of a thrown value. */
function errorMessage(error) {
	return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/**
 * Run one vision call over the harness LLM service and collect the text
 * description. Failures surface as thrown errors with provider/model context;
 * max-token truncation is reported through the returned `truncated` flag.
 */
async function runVisionCall(llm, { provider, model, messages, signal, timeoutMs, maxTokens }) {
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
	const assembler = new BlockAssembler();
	try {
		const stream = llm.stream({ provider, model, messages, signal: requestSignal, maxTokens });
		for await (const chunk of stream) assembler.push(chunk);
	} catch (error) {
		if (signal.aborted) throw error;
		throw new Error(`vision request to "${model}" (provider "${provider}") failed: ${errorMessage(error)}`, { cause: error });
	}
	const finish = assembler.finish;
	if (finish.kind === "error" || finish.kind === "aborted") {
		if (signal.aborted) throw new Error("vision request aborted");
		if (requestSignal.aborted) throw new Error(`vision request to "${model}" (provider "${provider}") timed out after ${timeoutMs}ms`);
		throw new Error(`vision request to "${model}" (provider "${provider}") failed: ${finish.failure?.message ?? "unknown error"}`);
	}
	if (finish.kind === "tool-calls") throw new Error(`vision model "${model}" (provider "${provider}") returned tool calls instead of a description`);
	if (finish.kind !== "stop" && finish.kind !== "max-tokens") {
		throw new Error(`vision request to "${model}" (provider "${provider}") ended with unexpected reason "${finish.kind}"`);
	}
	const text = assembler.blocks()
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (text.length === 0) throw new Error(`vision model "${model}" (provider "${provider}") returned no text content`);
	return { text, truncated: finish.kind === "max-tokens" };
}

/**
 * Register the `read_image_vision` tool. The composing plugin owns the
 * attachments gate: `apply` calls this inside `ctx.inject(['attachments'], …)`
 * so the tool exists only while a durable store is mounted. Execution still
 * re-checks `ctx.get('attachments')` for direct callers.
 * @param ctx - the registration scope; execution uses its `fs`/`llm` services plus the attachment store.
 * @param config - resolved plugin configuration (vision route and call caps).
 */
function applyVisionTool(ctx, config) {
	ctx.tools.register(defineTool({
		name: "read_image_vision",
		description: "Read a PNG/JPEG/WebP/GIF image through the configured vision-capable model and return its textual description. Use this when you need to see an image but your current model route cannot accept image input (read_image would be refused). The image and your task-specific `prompt` are sent to the configured vision model; it sees ONLY the image and your prompt — it has no access to the conversation, so write the prompt with every detail the answer depends on.",
		parameters: {
			file_path: {
				type: "string",
				required: true,
				description: "Path to the image file, resolved by the filesystem backend."
			},
			prompt: {
				type: "string",
				required: true,
				description: "Your task-specific instruction to the vision model about this image, e.g. 'Transcribe all visible text verbatim', 'Describe the layout and colors', 'Read the numbers in the table'. The vision model sees only the image and this prompt; include all context the answer depends on."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: {
						type: "string",
						required: true
					},
					provider: {
						type: "string",
						required: true
					},
					model: {
						type: "string",
						required: true
					},
					prompt: {
						type: "string",
						required: true
					},
					description: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			// The dsh-tools contract requires render to return a ContentBlock[]; a plain
			// string would be persisted verbatim as the tool-result `content`, which the
			// DeepSeek adapter's serializer cannot flatten (it calls blocks.filter), so the
			// follow-up request dies with a TRANSPORT "stream failed" error and the bad
			// block poisons every later request in the session.
			render: (_args, value) => [{
				type: "text",
				text: `<path>${value.path}</path>
<type>image-description</type>
<model>${value.provider}/${value.model}</model>
<content>
${value.description}${value.truncated ? "\n\n(Description truncated at the vision model's max output tokens; call again with a narrower prompt if you need the rest.)" : ""}
</content>`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const filePath = args.file_path.trim();
			if (filePath.length === 0) throw new Error("file_path must be a non-empty string");
			const prompt = args.prompt.trim();
			if (prompt.length === 0) throw new Error("prompt must be a non-empty string: the vision model sees only the image and your prompt, so state exactly what you need from the image");
			const mediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
			if (mediaType === void 0) throw new Error(`cannot read "${filePath}": read_image_vision only accepts PNG/JPEG/WebP/GIF paths`);
			const attachments = ctx.get("attachments");
			if (attachments === void 0) throw new Error(`cannot read "${filePath}" as an image: no attachment service is mounted`);
			if (!attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(`cannot read "${filePath}": ${mediaType} images are not accepted by this deployment`);
			const route = resolveVisionRoute(config);
			const llm = ctx.get("llm");
			if (llm === void 0) throw new Error(`cannot read "${filePath}": the LLM service is not mounted`);
			await assertImageCapableModel(llm, route.provider, route.model, exec.signal);
			const target = await ctx.fs.resolve(filePath, sessionResolveOptions(exec, filePath));
			const info = await ctx.fs.stat(target, exec.signal);
			if (info === void 0) {
				ctx.emit("fs/observed", target, { kind: "absent" }, exec);
				throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
			}
			if (info.type !== "file") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
			let data;
			try {
				data = await ctx.fs.readBytes(target, exec.signal, byteCap);
			} catch (error) {
				if (error instanceof FsError && error.code === "FS_TOO_LARGE") {
					throw new Error(`cannot read "${target.displayPath}": the image exceeds the ${byteCap}-byte attachment limit`);
				}
				throw error;
			}
			let ref;
			try {
				ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) });
			} catch (error) {
				if (error instanceof AttachmentError && error.code === "IMAGE_TYPE_MISMATCH") {
					const extension = extname(target.displayPath).toLowerCase();
					throw new Error(`cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`, { cause: error });
				}
				throw error;
			}
			ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);
			const message = createUserMessage({
				content: [
					{ type: "text", text: prompt },
					{ type: "image", attachment: ref }
				],
				source: { kind: "plugin", plugin: "tool-vision" }
			});
			const outcome = await runVisionCall(llm, {
				provider: route.provider,
				model: route.model,
				messages: [message],
				signal: exec.signal,
				timeoutMs: config.timeoutMs,
				maxTokens: config.maxTokens
			});
			return {
				path: target.displayPath,
				provider: route.provider,
				model: route.model,
				prompt,
				description: outcome.text,
				truncated: outcome.truncated
			};
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Read image ${args.file_path} via vision model`,
				kind: "read",
				locations: [{ path: args.file_path }]
			};
		}
	}));
}

/**
 * Mount the vision tool and its model-facing guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it.
 * @param config - resolved plugin configuration.
 */
function apply(ctx, config) {
	assertPositiveInteger("maxTokens", config.maxTokens);
	assertPositiveInteger("timeoutMs", config.timeoutMs);
	if (config.provider.trim().length === 0 || config.model.trim().length === 0) {
		ctx.logger.warn("tool-vision: no vision provider/model configured; read_image_vision will refuse calls until the tool-vision row config sets provider and model (profile cordis.patch.yml)");
	}
	ctx.systemPrompt.section({
		name: "tool:vision",
		order: 100,
		text: "Your current model route cannot receive images. To read an image, call the read_image_vision tool: it sends the image to the configured vision-capable model together with the task-specific `prompt` you pass. The vision model sees ONLY the image and that prompt — it has no access to this conversation — so write the prompt with every detail the answer depends on (e.g. 'Transcribe all visible text verbatim', 'Describe the layout and colors', 'Read the numbers in the table'). Use the returned description to continue the task."
	});
	ctx.inject(["attachments"], (imageCtx) => {
		applyVisionTool(imageCtx, config);
	});
}

export { Config, apply, inject, name };
