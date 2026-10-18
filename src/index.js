import { execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  ChatGPTDesktopError,
  DEFAULT_CDP_PORT,
  checkPortFree,
  finishFallbackLog,
  formatMessagesToPrompt,
  isChatGPTAppCommand,
  listModels,
  parsePortFromCommandArgs,
  parsePortOrCdpInput,
  probeClient,
  recordFallbackLog,
  resolveCdpPort,
  sendConversation,
} from "./core.js";

export default async function chatgptDesktopPlugin(input, pluginOptions = {}) {
  const providerId = "chatgpt-desktop";
  const appPath = pluginOptions?.appPath ?? "/Applications/ChatGPT.app";
  const stateFile =
    pluginOptions?.stateFile ??
    process.env.CHATGPT_DESKTOP_STATE_FILE ??
    null;

  const formatDiagnostic = (error) => {
    switch (error?.stage) {
      case "cdp_unreachable":
        return "ChatGPT Desktop 除錯埠未回應（CDP unreachable）。請在 Magpie 點選「Sign in」啟動或重開 ChatGPT.app。";
      case "renderer_not_unique":
        return "ChatGPT Desktop 主視窗數量異常（Main renderer window is not unique）。請確認 ChatGPT.app 已開啟且僅保留一個主視窗。";
      case "module_not_found":
      case "client_not_found":
        return "找不到 ChatGPT Desktop 內部連線物件（Internal client not found，可能因桌面版剛更新打包結構）。請在 Magpie 的 Plugins 頁面點選「Update」更新外掛。";
      case "attestation_failed":
        return "ChatGPT Desktop 裝置驗證挑戰失敗或尚未登入（Attestation challenge failed or not signed in）。請打開 ChatGPT.app 確認已完成帳號登入。";
      case "unsupported_input":
        return "ChatGPT Desktop 僅支援純文字訊息，不支援圖片、音訊、非文字附件或工具角色（Unsupported non-text input）。";
      case "quota_exceeded":
        return "ChatGPT Desktop 模型配額已滿（Quota exceeded: model_cap_exceeded）。如需自動退回 Instant 模型，請開啟供應商設定的「instant_fallback」開關。";
      case "unknown_send_state":
        return "ChatGPT Desktop 對話請求已送出但連線中斷或未確認完成狀態（Unknown send state）；為避免重複扣額，請勿自動重送。";
      default:
        return "ChatGPT Desktop 連線發生錯誤（Connection error）。請檢查 ChatGPT.app 狀態或在 Magpie 點選「Sign in」重新連線。";
    }
  };

  const readDesktopState = () => {
    if (stateFile) {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const running = Boolean(raw.running);
      const debuggingPort =
        typeof raw.debuggingPort === "number" ? raw.debuggingPort : null;
      const cdpUrl =
        typeof raw.cdpUrl === "string" && raw.cdpUrl
          ? raw.cdpUrl
          : running && debuggingPort !== null
            ? `http://127.0.0.1:${debuggingPort}`
            : null;
      return {
        platform: raw.platform ?? "darwin",
        appInstalled: raw.appInstalled ?? true,
        running,
        debuggingPort,
        cdpUrl,
        occupiedPorts: Array.isArray(raw.occupiedPorts) ? raw.occupiedPorts : [],
        launchedCdpUrl:
          typeof raw.launchedCdpUrl === "string" && raw.launchedCdpUrl
            ? raw.launchedCdpUrl
            : null,
        raw,
      };
    }

    const sysEnv = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    let lines = [];
    try {
      const output = String(
        execSync("/bin/ps -ax -o command=", {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          env: sysEnv,
        }),
      );
      lines = output.split(/\r?\n/).filter(isChatGPTAppCommand);
    } catch {
      lines = [];
    }

    const running = lines.length > 0;
    const debuggingPort = parsePortFromCommandArgs(lines);
    const configured = parsePortOrCdpInput(
      pluginOptions?.cdpUrl ??
        pluginOptions?.port ??
        process.env.CHATGPT_CDP_PORT ??
        process.env.SIDECAR_CDP ??
        process.env.CODEX_CDP_PORT,
    );
    const cdpUrl =
      configured?.cdpUrl ??
      (debuggingPort !== null ? `http://127.0.0.1:${debuggingPort}` : null);

    return {
      platform: process.platform,
      appInstalled: fs.existsSync(appPath),
      running,
      debuggingPort,
      cdpUrl,
      occupiedPorts: [],
      launchedCdpUrl: null,
      raw: null,
    };
  };

  const probeExistingDesktop = async (desktop) => {
    if (!desktop.running) {
      return { ok: false, cdpReachable: false, error: null };
    }
    if (stateFile && !desktop.cdpUrl) {
      return { ok: false, cdpReachable: false, error: null };
    }
    const candidateUrl =
      desktop.cdpUrl ?? `http://127.0.0.1:${DEFAULT_CDP_PORT}`;
    try {
      const res = await probeClient({
        cdpUrl: candidateUrl,
        timeoutMs: pluginOptions?.probeTimeoutMs ?? 5000,
        targetTimeoutMs: pluginOptions?.targetTimeoutMs ?? 2000,
      });
      if (!res.challengeOk) {
        return {
          ok: false,
          cdpReachable: true,
          cdpUrl: candidateUrl,
          error: new ChatGPTDesktopError("裝置驗證失敗", {
            stage: "attestation_failed",
            retrySafe: true,
          }),
        };
      }
      return { ok: true, cdpReachable: true, cdpUrl: candidateUrl, error: null };
    } catch (error) {
      if (error?.stage === "cdp_unreachable") {
        return { ok: false, cdpReachable: false, error };
      }
      return { ok: false, cdpReachable: true, error };
    }
  };

  const launchOrRestartDesktop = async (desktop, shouldQuit) => {
    if (shouldQuit) {
      if (stateFile) {
        const current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        current.quits = (current.quits ?? 0) + 1;
        current.running = false;
        current.debuggingPort = null;
        current.cdpUrl = null;
        fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));
      } else {
        const sysEnv = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
        try {
          execFileSync(
            "/usr/bin/osascript",
            ["-e", 'tell application "ChatGPT" to quit'],
            { stdio: "ignore", env: sysEnv },
          );
        } catch {
          // 忽略 osascript 例外，後續以程序輪詢確認退出狀態。
        }
        const quitDeadline = Date.now() + 10000;
        while (Date.now() < quitDeadline) {
          if (!readDesktopState().running) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }

    const resolved = await resolveCdpPort({
      configuredPort: pluginOptions?.port,
      env: stateFile ? {} : process.env,
      runningProcessArgs: "",
      forLaunch: true,
      isPortFree: async (port, host) => {
        if (desktop.occupiedPorts.includes(port)) return false;
        return checkPortFree(port, host);
      },
    });

    let targetCdpUrl = resolved.cdpUrl;
    if (stateFile) {
      const current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const launches = Array.isArray(current.launches) ? current.launches : [];
      launches.push({
        port: resolved.port,
        args: [`--remote-debugging-port=${resolved.port}`],
      });
      current.launches = launches;
      current.running = true;
      current.debuggingPort = resolved.port;
      targetCdpUrl = current.launchedCdpUrl ?? resolved.cdpUrl;
      current.cdpUrl = targetCdpUrl;
      fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));
    } else {
      execFileSync(
        "/usr/bin/open",
        ["-a", appPath, "--args", `--remote-debugging-port=${resolved.port}`],
        {
          stdio: "ignore",
          env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        },
      );
    }

    const waitMs = stateFile ? 500 : 20000;
    const pollIntervalMs = stateFile ? 30 : 400;
    const deadline = Date.now() + waitMs;
    let lastError = null;
    while (true) {
      try {
        const res = await probeClient({
          cdpUrl: targetCdpUrl,
          timeoutMs: pluginOptions?.probeTimeoutMs ?? 5000,
          targetTimeoutMs: pluginOptions?.targetTimeoutMs ?? 2000,
        });
        if (!res.challengeOk) {
          lastError = new ChatGPTDesktopError("裝置驗證失敗", {
            stage: "attestation_failed",
            retrySafe: true,
          });
        } else {
          return { ok: true, cdpUrl: targetCdpUrl };
        }
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        return { ok: false, cdpUrl: targetCdpUrl, error: lastError };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  };

  // 非登入流程（models、usage、fetch）僅讀取並連接現有除錯埠，絕不啟動、退出或重開桌面版。
  const resolveActiveCdpUrl = async (auth) => {
    if (stateFile) {
      const desktop = readDesktopState();
      if (!desktop.running || !desktop.cdpUrl) {
        throw new ChatGPTDesktopError("除錯埠未回應", {
          stage: "cdp_unreachable",
          retrySafe: true,
          status: 503,
        });
      }
      return desktop.cdpUrl;
    }

    const resolved = await resolveCdpPort({
      configuredPort: pluginOptions?.port,
      env: process.env,
      forLaunch: false,
    });
    if (resolved.source !== "default") {
      return resolved.cdpUrl;
    }
    if (typeof auth?.access === "string" && auth.access.startsWith("http")) {
      return auth.access;
    }
    return resolved.cdpUrl;
  };

  const restartPromptSpec = {
    type: "select",
    key: "restart_action",
    message:
      "ChatGPT.app 正在執行但未開啟除錯埠。重啟桌面版會關閉目前視窗並遺失未送出的草稿（closing windows and unsaved drafts），是否要自動重開？",
    options: [
      {
        label: "自動關閉並以除錯埠模式重開 ChatGPT.app (Restart automatically)",
        value: "restart",
        hint: "會關閉目前桌面版視窗與未送出草稿，並自動帶高號段除錯埠重開",
      },
      {
        label: "我自己手動重開後再試 (Restart manually)",
        value: "manual",
        hint: "保留目前桌面版視窗，不自動關閉程序",
      },
    ],
  };

  return {
    async config(cfg) {
      cfg.provider ??= {};
      const existing = cfg.provider[providerId] ?? {};
      cfg.provider[providerId] = {
        ...existing,
        name: existing.name ?? "ChatGPT Desktop",
        npm: existing.npm ?? "@ai-sdk/openai-compatible",
        api: existing.api ?? "http://127.0.0.1/v1",
        models: existing.models ?? {},
      };
    },

    provider: {
      id: providerId,
      async models(_given, ctx) {
        try {
          const cdpUrl = await resolveActiveCdpUrl(ctx?.auth);
          const { models } = await listModels({
            cdpUrl,
            timeoutMs: pluginOptions?.modelsTimeoutMs ?? 5000,
            targetTimeoutMs: pluginOptions?.targetTimeoutMs ?? 2000,
          });
          const out = {};
          for (const m of models) {
            const reasoning = Boolean(m.reasoning);
            out[m.slug] = {
              id: m.slug,
              name: m.name,
              tool_call: false,
              attachment: false,
              reasoning,
              modalities: {
                input: ["text"],
                output: ["text"],
              },
              capabilities: {
                temperature: false,
                reasoning,
                attachment: false,
                toolcall: false,
                input: {
                  text: true,
                  image: false,
                  audio: false,
                  video: false,
                  pdf: false,
                },
                output: {
                  text: true,
                  image: false,
                  audio: false,
                  video: false,
                  pdf: false,
                },
                interleaved: false,
              },
            };
          }
          return out;
        } catch (error) {
          throw new Error(formatDiagnostic(error));
        }
      },
    },

    auth: {
      provider: providerId,
      maxConcurrency: 1,
      options: [
        {
          key: "instant_fallback",
          label: "Quota fallback to Instant",
          description:
            "當 Pro 或 Thinking 模型遇到 model_cap_exceeded 配額拒絕且無對話活動時，自動改送同版本非工作模式 Instant 模型一次（預設關閉，不靜默降級）。",
          default: false,
        },
      ],
      methods: [
        {
          type: "oauth",
          label: "Connect macOS ChatGPT Desktop",
          prompts: [restartPromptSpec],
          async ask(inputs = {}) {
            if (inputs?.restart_action) return null;
            const desktop = readDesktopState();
            if (desktop.platform !== "darwin" || !desktop.appInstalled) {
              return null;
            }
            if (!desktop.running) {
              return null;
            }
            const probe = await probeExistingDesktop(desktop);
            if (probe.cdpReachable) {
              return null;
            }
            return restartPromptSpec;
          },
          async authorize(inputs = {}) {
            return {
              url: "",
              instructions: "Connecting to local macOS ChatGPT Desktop...",
              method: "auto",
              async callback() {
                const desktop = readDesktopState();
                if (desktop.platform !== "darwin" || !desktop.appInstalled) {
                  return {
                    type: "failed",
                    error:
                      "此供應商需要安裝 macOS 版官方 ChatGPT 桌面應用程式（/Applications/ChatGPT.app）。",
                  };
                }

                if (desktop.running) {
                  const probe = await probeExistingDesktop(desktop);
                  if (probe.ok) {
                    return {
                      type: "success",
                      refresh: probe.cdpUrl,
                      access: probe.cdpUrl,
                      expires: 0,
                      accountId: "ChatGPT Desktop",
                    };
                  }
                  if (probe.cdpReachable) {
                    return {
                      type: "failed",
                      error: formatDiagnostic(probe.error),
                    };
                  }
                  if (inputs?.restart_action !== "restart") {
                    return {
                      type: "failed",
                      error:
                        "已取消自動重開：未關閉執行中的 ChatGPT.app。請手動以除錯埠模式重開桌面版，或在登入選單選擇自動重開。",
                    };
                  }
                  const restarted = await launchOrRestartDesktop(desktop, true);
                  if (!restarted.ok) {
                    return {
                      type: "failed",
                      error: formatDiagnostic(restarted.error),
                    };
                  }
                  return {
                    type: "success",
                    refresh: restarted.cdpUrl,
                    access: restarted.cdpUrl,
                    expires: 0,
                    accountId: "ChatGPT Desktop",
                  };
                }

                const launched = await launchOrRestartDesktop(desktop, false);
                if (!launched.ok) {
                  return {
                    type: "failed",
                    error: formatDiagnostic(launched.error),
                  };
                }
                return {
                  type: "success",
                  refresh: launched.cdpUrl,
                  access: launched.cdpUrl,
                  expires: 0,
                  accountId: "ChatGPT Desktop",
                };
              },
            };
          },
        },
      ],

      async usage(getAuth) {
        try {
          const auth = typeof getAuth === "function" ? await getAuth() : null;
          const cdpUrl = await resolveActiveCdpUrl(auth);
          const probe = await probeClient({
            cdpUrl,
            timeoutMs: pluginOptions?.probeTimeoutMs ?? 5000,
            targetTimeoutMs: pluginOptions?.targetTimeoutMs ?? 2000,
          });
          if (!probe.challengeOk) {
            return {
              plan: "ChatGPT Desktop",
              error: formatDiagnostic({ stage: "attestation_failed" }),
            };
          }
          return {
            plan: "ChatGPT Desktop",
            user: "ChatGPT Desktop",
            signIn: "kept",
          };
        } catch (error) {
          return {
            plan: "ChatGPT Desktop",
            error: formatDiagnostic(error),
          };
        }
      },

      async loader(getAuth) {
        return {
          apiKey: "chatgpt-desktop",
          baseURL: "http://127.0.0.1/v1",
          fetch: async (_requestUrl, init = {}) => {
            let payload = {};
            try {
              const rawBody =
                typeof init?.body === "string"
                  ? init.body
                  : init?.body
                    ? String(init.body)
                    : "{}";
              payload = JSON.parse(rawBody);
            } catch {
              return new Response(
                JSON.stringify({
                  error: {
                    message: "無效的 JSON 請求內容（Invalid JSON body）。",
                    type: "invalid_request_error",
                  },
                }),
                {
                  status: 400,
                  headers: { "content-type": "application/json" },
                },
              );
            }

            try {
              if (
                (Array.isArray(payload?.attachments) &&
                  payload.attachments.length > 0) ||
                (Array.isArray(payload?.files) && payload.files.length > 0) ||
                payload?.image != null ||
                payload?.audio != null
              ) {
                throw new ChatGPTDesktopError("不支援非文字附件輸入", {
                  stage: "unsupported_input",
                  retrySafe: true,
                  status: 400,
                });
              }

              const formattedPrompt = formatMessagesToPrompt(
                payload.messages ?? payload.prompt,
              );
              const auth =
                typeof getAuth === "function" ? await getAuth() : null;
              const cdpUrl = await resolveActiveCdpUrl(auth);
              const instantFallback = Boolean(
                input?.magpie?.option?.(providerId, "instant_fallback"),
              );
              const effort =
                typeof payload.reasoning_effort === "string" &&
                payload.reasoning_effort.trim()
                  ? payload.reasoning_effort.trim()
                  : typeof payload.reasoning?.effort === "string" &&
                      payload.reasoning.effort.trim()
                    ? payload.reasoning.effort.trim()
                    : "standard";

              const result = await sendConversation({
                cdpUrl,
                prompt: formattedPrompt,
                model: payload.model,
                effort,
                instantFallback,
                allowProFallback: true,
                timeoutMs: pluginOptions?.chatTimeoutMs ?? 300000,
                targetTimeoutMs: pluginOptions?.targetTimeoutMs ?? 4000,
                signal: init?.signal,
                onFallbackStart: ({ fallbackId, requestedModel }) => {
                  try {
                    recordFallbackLog("fallback_started", fallbackId, requestedModel, {
                      reason_code: "model_cap_exceeded",
                      fallback_mode: "Instant",
                    });
                  } catch {
                    // 外掛宿主內紀錄寫入失敗不阻擋請求。
                  }
                },
                onFallbackFailed: ({ fallbackId, requestedModel, error: fbErr }) => {
                  finishFallbackLog(
                    "fallback_failed",
                    fallbackId,
                    requestedModel,
                    {
                      retry_safe: Boolean(fbErr?.retrySafe),
                      reason_code: fbErr?.details?.errorCode ?? null,
                    },
                    { writeStderr: () => {} },
                  );
                },
                onFallbackComplete: ({ fallbackId, requestedModel, result: okRes }) => {
                  finishFallbackLog(
                    "fallback_completed",
                    fallbackId,
                    requestedModel,
                    {
                      sent_model: okRes.requestedModel,
                      actual_model: okRes.model,
                      conversation_id: okRes.conversationId,
                    },
                    { writeStderr: () => {} },
                  );
                },
              });

              const completionId = `chatcmpl-${result.conversationId ?? crypto.randomUUID()}`;
              const created = Math.floor(Date.now() / 1000);
              const modelId = result.model ?? payload.model ?? providerId;

              if (payload.stream === true) {
                const deltaChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: modelId,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: result.answer },
                      finish_reason: null,
                    },
                  ],
                };
                const stopChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: modelId,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                };
                const ssePayload =
                  `data: ${JSON.stringify(deltaChunk)}\n\n` +
                  `data: ${JSON.stringify(stopChunk)}\n\n` +
                  `data: [DONE]\n\n`;
                return new Response(ssePayload, {
                  status: 200,
                  headers: {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache",
                  },
                });
              }

              return new Response(
                JSON.stringify({
                  id: completionId,
                  object: "chat.completion",
                  created,
                  model: modelId,
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: result.answer,
                      },
                      finish_reason: "stop",
                    },
                  ],
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              );
            } catch (error) {
              const message = formatDiagnostic(error);
              if (
                error?.stage === "unsupported_input" ||
                error?.status === 400
              ) {
                return new Response(
                  JSON.stringify({
                    error: {
                      message,
                      type: "invalid_request_error",
                      code: "unsupported_input",
                    },
                  }),
                  {
                    status: 400,
                    headers: { "content-type": "application/json" },
                  },
                );
              }

              if (
                error?.retrySafe === false ||
                error?.stage === "unknown_send_state"
              ) {
                return new Response(
                  JSON.stringify({
                    error: {
                      message,
                      type: "upstream_error",
                      code: "unknown_send_state",
                    },
                  }),
                  {
                    status: 502,
                    headers: {
                      "content-type": "application/json",
                      "X-Should-Retry": "false",
                      "Retry-After": "60",
                    },
                  },
                );
              }

              if (error?.stage === "quota_exceeded" || error?.status === 429) {
                return new Response(
                  JSON.stringify({
                    error: {
                      message,
                      type: "insufficient_quota",
                      code: "model_cap_exceeded",
                    },
                  }),
                  {
                    status: 429,
                    headers: {
                      "content-type": "application/json",
                      "Retry-After": "60",
                    },
                  },
                );
              }

              return new Response(
                JSON.stringify({
                  error: {
                    message,
                    type: "service_unavailable",
                    code: error?.stage ?? "unavailable",
                  },
                }),
                {
                  status: 503,
                  headers: {
                    "content-type": "application/json",
                    "Retry-After": "60",
                  },
                },
              );
            }
          },
        };
      },
    },
  };
}

