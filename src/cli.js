#!/usr/bin/env bun
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ChatGPTDesktopError,
  buildChatExpression,
  buildModelsExpression,
  buildProbeExpression,
  buildResolverJs,
  finishFallbackLog,
  preferredClientExports,
  probeClient,
  recordFallbackLog,
  sendConversation,
} from "./core.js";

const RENDER_EXPRESSION_KINDS = ["probe", "models", "chat", "resolver"];

const pluginVersion = () => {
  try {
    const raw = fs.readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    );
    return String(JSON.parse(raw).version ?? "unknown");
  } catch {
    return "unknown";
  }
};

const readStreamText = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const runCli = async (
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdin = process.stdin,
    stdinText,
    writeStdout = (text) => process.stdout.write(text),
    writeStderr = (text) => process.stderr.write(text),
    cdpUrl,
    configuredPort,
    runningProcessArgs,
    detectRunningPort,
    fetchImpl,
    WebSocketImpl,
    timeoutMs,
    targetTimeoutMs,
    signal,
    logPath,
  } = {},
) => {
  if (argv[0] === "--render-expression") {
    const kind = argv[1];
    const preferred = preferredClientExports(env);
    if (kind === "probe") {
      writeStdout(buildProbeExpression(preferred));
      return 0;
    }
    if (kind === "models") {
      writeStdout(buildModelsExpression(preferred));
      return 0;
    }
    if (kind === "resolver") {
      writeStdout(buildResolverJs(preferred));
      return 0;
    }
    if (kind === "chat") {
      let options = {};
      if (argv[2]) {
        try {
          options = JSON.parse(argv[2]);
        } catch (error) {
          writeStderr(`無效的 options JSON：${error?.message ?? error}\n`);
          return 1;
        }
      }
      writeStdout(buildChatExpression(options, preferred));
      return 0;
    }
    // 呼叫端靠版本號與支援清單判斷「已安裝的外掛太舊、不認得這個類型」。
    writeStderr(
      `不支援的 expression 類型：${kind ?? ""}（magpie-chatgpt-desktop ${pluginVersion()}，支援：${RENDER_EXPRESSION_KINDS.join(", ")}）\n`,
    );
    return 1;
  }

  if (argv[0] === "--probe") {
    try {
      const result = await probeClient({
        cdpUrl,
        configuredPort,
        env,
        runningProcessArgs,
        detectRunningPort,
        fetchImpl,
        WebSocketImpl,
        timeoutMs: timeoutMs ?? 30000,
        targetTimeoutMs,
        signal,
      });
      writeStdout(JSON.stringify(result) + "\n");
      return 0;
    } catch (error) {
      writeStdout(
        JSON.stringify({
          ok: false,
          error: String(error?.message ?? error),
        }) + "\n",
      );
      return 1;
    }
  }

  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg === "--instant-fallback" || arg === "--no-instant-fallback") {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }

  const rawPrompt =
    stdinText !== undefined ? String(stdinText) : await readStreamText(stdin);
  const prompt = rawPrompt.trim();
  if (!prompt) {
    writeStderr("stdin 沒有內容\n");
    return 1;
  }

  const selectedModel =
    positional[0] ?? String(env?.SIDECAR_WEB_MODEL ?? "").trim();

  if (!selectedModel) {
    writeStderr("未指定模型\n");
    return 1;
  }

  const rawEffort = String(env?.SIDECAR_WEB_EFFORT ?? "").trim();
  const effort = rawEffort.length > 0 ? rawEffort : "standard";
  const instantFallback =
    !flags.has("--no-instant-fallback") &&
    env?.SIDECAR_INSTANT_FALLBACK !== "0" &&
    env?.SIDECAR_INSTANT_FALLBACK !== "false";
  const allowProFallback =
    flags.has("--instant-fallback") ||
    env?.SIDECAR_INSTANT_FALLBACK === "all" ||
    env?.SIDECAR_INSTANT_FALLBACK === "1" ||
    env?.SIDECAR_INSTANT_FALLBACK === "true";

  try {
    const result = await sendConversation({
      prompt,
      model: selectedModel,
      effort,
      instantFallback,
      allowProFallback,
      cdpUrl,
      configuredPort,
      env,
      runningProcessArgs,
      detectRunningPort,
      fetchImpl,
      WebSocketImpl,
      timeoutMs: timeoutMs ?? 300000,
      targetTimeoutMs,
      signal,
      onFallbackStart: ({ fallbackId, requestedModel }) => {
        try {
          recordFallbackLog(
            "fallback_started",
            fallbackId,
            requestedModel,
            {
              reason_code: "model_cap_exceeded",
              fallback_mode: "Instant",
            },
            { env, logPath },
          );
        } catch (logError) {
          throw new ChatGPTDesktopError(
            `未啟動 Instant：無法記錄降級（${logError?.message ?? logError}）`,
            {
              stage: "quota_exceeded",
              retrySafe: true,
              status: 429,
              cause: logError,
            },
          );
        }
        writeStderr("Thinking 配額已拒絕，改用 Instant 一次。\n");
      },
      onFallbackFailed: ({ fallbackId, requestedModel, error }) => {
        finishFallbackLog(
          "fallback_failed",
          fallbackId,
          requestedModel,
          {
            retry_safe: Boolean(error?.retrySafe),
            reason_code: error?.details?.errorCode ?? null,
          },
          { env, logPath, writeStderr },
        );
      },
      onFallbackComplete: ({ fallbackId, requestedModel, result: okResult }) => {
        finishFallbackLog(
          "fallback_completed",
          fallbackId,
          requestedModel,
          {
            sent_model: okResult.requestedModel,
            actual_model: okResult.model,
            conversation_id: okResult.conversationId,
          },
          { env, logPath, writeStderr },
        );
      },
    });

    const preferred = preferredClientExports(env);
    if (result.clientExport && result.clientExport !== preferred[0]) {
      writeStderr(
        `注意：client export 已從 ${preferred[0]} 漂移到 ${result.clientExport}\n`,
      );
    }
    writeStdout(`${result.answer}\n`);
    return 0;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.retrySafe === false) {
      writeStderr(
        `SIDECAR_WEB_RETRY_UNSAFE ${JSON.stringify({ error: message })}\n`,
      );
      return 3;
    }
    writeStderr(`${message}\n`);
    return 1;
  }
};

const isMainModule = () => {
  if (typeof import.meta.main === "boolean") {
    return import.meta.main;
  }
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (isMainModule()) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
