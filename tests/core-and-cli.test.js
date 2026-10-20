import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import {
  ChatGPTDesktopError,
  DEFAULT_CDP_PORT,
  HIGH_PORT_MAX,
  HIGH_PORT_MIN,
  RENDERER_URL,
  evaluateInRenderer,
  findFreeHighPort,
  formatMessagesToPrompt,
  getRendererTarget,
  isChatGPTAppCommand,
  listModels,
  normalizeThinkingEffort,
  parsePortFromCommandArgs,
  preferredClientExports,
  probeClient,
  resetUnusualActivityCooldown,
  resolveCdpPort,
  sendConversation,
} from "../src/core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../src/cli.js");

const THINKING_MODEL = "gpt-5-6-thinking";
const PRO_MODEL = "gpt-6-pro";
const INSTANT_MODEL = "gpt-5-6-instant";
const DEFAULT_ANSWER = '{"tag":"verified-answer"}';

const DEFAULT_CATALOG = {
  models: [
    {
      slug: THINKING_MODEL,
      title: "GPT-5.6 Thinking",
      is_work_mode_model: false,
      reasoning: true,
    },
    {
      slug: PRO_MODEL,
      title: "GPT-6 Pro",
      is_work_mode_model: true,
      reasoning: true,
    },
    {
      slug: INSTANT_MODEL,
      title: "GPT-5.6 Instant",
      is_work_mode_model: false,
      reasoning: false,
    },
  ],
  versions: [
    {
      enabled: true,
      intelligence_presets: [
        {
          model_slug: THINKING_MODEL,
          lane: "thinking",
          preset_type: "available",
        },
        {
          model_slug: PRO_MODEL,
          lane: "pro",
          preset_type: "available",
        },
        {
          model_slug: INSTANT_MODEL,
          lane: "instant",
          preset_type: "available",
        },
      ],
    },
  ],
};

/**
 * 啟動真實的本機模擬 CDP HTTP + WebSocket 伺服器，
 * 並在收到 Runtime.evaluate 時實際執行由 core.js 產生的 JS expression。
 */
const startMockCdpServer = async (scenario = {}) => {
  const state = {
    httpListCount: 0,
    wsConnections: 0,
    wsClosedCount: 0,
    evaluateCount: 0,
    requests: [],
    reads: [],
    closeResolvers: [],
  };

  let server;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/json/list") {
        state.httpListCount += 1;
        if (scenario.httpStatus && scenario.httpStatus !== 200) {
          return new Response("error", { status: scenario.httpStatus });
        }
        const wsUrl = `ws://127.0.0.1:${srv.port}/devtools/page/1`;
        const pageCount = scenario.pageCount ?? 1;
        const targets = [];
        for (let i = 0; i < pageCount; i += 1) {
          targets.push({
            id: `page-${i + 1}`,
            type: "page",
            url: RENDERER_URL,
            webSocketDebuggerUrl: wsUrl,
          });
        }
        return Response.json(targets);
      }
      if (url.pathname === "/devtools/page/1") {
        if (srv.upgrade(req)) return undefined;
        return new Response("Upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open() {
        state.wsConnections += 1;
      },
      async message(ws, rawMessage) {
        state.evaluateCount += 1;
        const cmd = JSON.parse(String(rawMessage));
        if (scenario.invalidCdpReply) {
          ws.send("{malformed-json");
          return;
        }
        if (scenario.closeOnEvaluate) {
          ws.close();
          return;
        }
        if (scenario.hangForever) {
          return;
        }

        const expression = cmd.params.expression;
        const catalog = scenario.catalog ?? DEFAULT_CATALOG;
        const answer = scenario.answer ?? DEFAULT_ANSWER;
        const exportName = scenario.exportName ?? "cF";
        const moduleSourceFor = (targetExportName) => {
          if (scenario.noClientExports) {
            return `  export default { foo: "bar" };`;
          }
          return [
            `  const scenario = ${JSON.stringify(scenario)};`,
            `  const catalog = ${JSON.stringify(catalog)};`,
            `  const answer = ${JSON.stringify(answer)};`,
            `  export const ${targetExportName} = {`,
            `    safeGet: async (path) => {`,
            `      globalThis.__testReads.push(path);`,
            `      if (path === "/ios/attestation_challenge") {`,
            `        if (scenario.attestationFails) throw new Error("401 unauthorized");`,
            `        return { attestation_challenge: "challenge-token-xyz" };`,
            `      }`,
            `      if (path.startsWith("/models")) {`,
            `        if (scenario.noInstant) return { models: [], versions: [] };`,
            `        if (scenario.proAsInstant) {`,
            `          return {`,
            `            models: [{ slug: "gpt-6-pro", is_work_mode_model: false }],`,
            `            versions: [{`,
            `              enabled: true,`,
            `              intelligence_presets: [`,
            `                { model_slug: "gpt-5-6-thinking", lane: "thinking", preset_type: "available" },`,
            `                { model_slug: "gpt-6-pro", lane: "instant", preset_type: "available" },`,
            `              ],`,
            `            }],`,
            `          };`,
            `        }`,
            `        if (scenario.workModeInstant) {`,
            `          return {`,
            `            models: [{ slug: "gpt-5-6-instant", is_work_mode_model: true }],`,
            `            versions: [{`,
            `              enabled: true,`,
            `              intelligence_presets: [`,
            `                { model_slug: "gpt-5-6-thinking", lane: "thinking", preset_type: "available" },`,
            `                { model_slug: "gpt-5-6-instant", lane: "instant", preset_type: "available" },`,
            `              ],`,
            `            }],`,
            `          };`,
            `        }`,
            `        if (scenario.crossVersionOnlyInstant) {`,
            `          return {`,
            `            models: [{ slug: "gpt-5-3-instant", is_work_mode_model: false }],`,
            `            versions: [{`,
            `              enabled: true,`,
            `              intelligence_presets: [`,
            `                { model_slug: "gpt-5-3-thinking", lane: "thinking", preset_type: "available" },`,
            `                { model_slug: "gpt-5-3-instant", lane: "instant", preset_type: "available" },`,
            `              ],`,
            `            }],`,
            `          };`,
            `        }`,
            `        return catalog;`,
            `      }`,
            `      if (scenario.throwEmptyErrorOnConversationGet) {`,
            `        throw new Error("");`,
            `      }`,
            `      if (scenario.kind === "accepted-quota" || scenario.emptyConversation) {`,
            `        return { mapping: {} };`,
            `      }`,
            `      const requestedSlug = globalThis.__testRequests.at(-1)?.model ?? null;`,
            `      return {`,
            `        mapping: {`,
            `          nodeThought: {`,
            `            message: {`,
            `              author: { role: "assistant" },`,
            `              status: "finished_successfully",`,
            `              content: { content_type: "thought", parts: ["internal thought that must be skipped"] },`,
            `              create_time: 200,`,
            `              metadata: { model_slug: requestedSlug },`,
            `            },`,
            `          },`,
            `          nodeReasoning: {`,
            `            message: {`,
            `              author: { role: "assistant" },`,
            `              status: "finished_successfully",`,
            `              content: { content_type: "reasoning", parts: ["internal reasoning that must be skipped"] },`,
            `              create_time: 300,`,
            `              metadata: { model_slug: requestedSlug },`,
            `            },`,
            `          },`,
            `          nodeInProgress: {`,
            `            message: {`,
            `              author: { role: "assistant" },`,
            `              status: "in_progress",`,
            `              content: { content_type: "text", parts: ["unfinished draft"] },`,
            `              create_time: 400,`,
            `              metadata: { model_slug: requestedSlug },`,
            `            },`,
            `          },`,
            `          nodeFinal: {`,
            `            message: {`,
            `              author: { role: "assistant" },`,
            `              status: "finished_successfully",`,
            `              content: { content_type: "text", parts: [answer] },`,
            `              create_time: 100,`,
            `              metadata: { model_slug: requestedSlug },`,
            `            },`,
            `          },`,
            `        },`,
            `      };`,
            `    },`,
            `    streamPost: (_path, init) => {`,
            `      const body = JSON.parse(init.body);`,
            `      globalThis.__testRequests.push(body);`,
            `      const quota = { detail: { code: "model_cap_exceeded", message: "Allowance exhausted" } };`,
            `      if (scenario.kind === "stream-complete") {`,
            `        init.onEvent({`,
            `          type: "fetch-stream-event",`,
            `          data: {`,
            `            conversation_id: "conv-stream-456",`,
            `            message: {`,
            `              author: { role: "assistant" },`,
            `              status: "finished_successfully",`,
            `              channel: "final",`,
            `              recipient: "all",`,
            `              content: { content_type: "text", parts: [answer] },`,
            `              create_time: 500,`,
            `              metadata: { model_slug: body.model },`,
            `            },`,
            `          },`,
            `        });`,
            `        init.onComplete({ conversation_id: "conv-stream-456" });`,
            `      } else if (scenario.kind === "success" || (body.model.endsWith("-instant") && !scenario.instantQuota)) {`,
            `        init.onComplete({ conversation_id: "conv-123" });`,
            `      } else if (scenario.kind === "unusual") {`,
            `        init.onEvent({ type: "fetch-stream-event", data: { conversation_id: "conv-unusual" } });`,
            `        init.onError({ type: "fetch-stream-error", error: JSON.stringify({ error: "Our systems have detected unusual activity coming from your system. Please try again later." }), responseStatus: 200, failureOrigin: "server_stream" });`,
            `      } else if (scenario.kind === "rejected") {`,
            `        init.onError({ type: "fetch-stream-error", error: JSON.stringify({ detail: "Unusual activity has been detected from your device. Try again later." }), responseStatus: 403 });`,
            `      } else if (scenario.kind === "rate") {`,
            `        init.onError({ status: 429, error: { code: "rate_limit_exceeded" } });`,
            `      } else if (scenario.kind === "conflicting-code") {`,
            `        init.onError({ code: "rate_limit_exceeded", message: JSON.stringify(quota) });`,
            `      } else if (scenario.kind === "premature") {`,
            `        init.onPrematureTermination();`,
            `      } else if (scenario.kind === "accepted-quota") {`,
            `        init.onEvent({ conversation_id: "conv-accepted" });`,
            `        init.onError(quota);`,
            `      } else if (scenario.kind === "partial-quota") {`,
            `        init.onEvent({ message: { author: { role: "assistant" }, status: "in_progress" } });`,
            `        init.onError(quota);`,
            `      } else {`,
            `        init.onError(quota);`,
            `      }`,
            `      return "stream-handle";`,
            `    },`,
            `    cancelStream: () => {},`,
            `  };`,
          ].join("\n");
        };

        const sharedModuleCode = scenario.sharedRpcPromiseOnly
          ? [
              `  export default {`,
              `    safeGet: Object.assign(() => {}, { toString: () => "[object RpcPromise]" }),`,
              `    streamPost: () => {},`,
              `    cancelStream: () => {},`,
              `  };`,
            ].join("\n")
          : moduleSourceFor(exportName);

        const initialModuleCode = moduleSourceFor(
          scenario.initialExportName ?? "initClient",
        );

        const sharedUrl =
          "data:text/javascript," +
          encodeURIComponent(sharedModuleCode + "\n//") +
          `#/assets/app-shared-${crypto.randomUUID()}.js`;
        const initialUrl =
          "data:text/javascript," +
          encodeURIComponent(initialModuleCode + "\n//") +
          `#/assets/app-initial-${crypto.randomUUID()}.js`;

        const resourceEntries = scenario.noModules
          ? []
          : [{ name: sharedUrl }, { name: initialUrl }];

        const prevPerformance = globalThis.performance;
        const prevDocument = globalThis.document;
        const requests = [];
        const reads = [];
        globalThis.__testRequests = requests;
        globalThis.__testReads = reads;
        globalThis.performance = {
          getEntriesByType: () => resourceEntries,
        };
        globalThis.document = {
          querySelectorAll: () => [],
        };

        let evalResult;
        try {
          const AsyncFunction = Object.getPrototypeOf(
            async function () {},
          ).constructor;
          const fn = new AsyncFunction(`return await ${expression};`);
          const result = await fn();
          evalResult = { result, requests, reads };
        } finally {
          globalThis.performance = prevPerformance;
          globalThis.document = prevDocument;
          delete globalThis.__testRequests;
          delete globalThis.__testReads;
        }
        state.requests.push(...evalResult.requests);
        state.reads.push(...evalResult.reads);

        if (
          scenario.instantTimeout &&
          evalResult.requests.some((r) => r.model === INSTANT_MODEL)
        ) {
          return;
        }

        ws.send(
          JSON.stringify({
            id: cmd.id,
            result: {
              result: {
                type: "object",
                value: evalResult.result,
              },
            },
          }),
        );
      },
      close() {
        state.wsClosedCount += 1;
        for (const r of state.closeResolvers.splice(0)) {
          r();
        }
      },
    },
  });

  const waitForWsClose = (expectedCount = 1, timeoutMs = 2000) => {
    if (state.wsClosedCount >= expectedCount) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for WebSocket close")),
        timeoutMs,
      );
      state.closeResolvers.push(() => {
        if (state.wsClosedCount >= expectedCount) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  };

  return {
    port: server.port,
    cdpUrl: `http://127.0.0.1:${server.port}`,
    wsUrl: `ws://127.0.0.1:${server.port}/devtools/page/1`,
    state,
    waitForWsClose,
    stop: () => server.stop(true),
  };
};

describe("Ticket 01 — 三層除錯埠決定與高號段避讓、主畫面唯一性檢查", () => {
  test("三層規則：1. 手動設定或執行中程序參數優先 → 2. 啟動時高號段 58000–65000 空閒埠 → 3. 保底預設 19333", async () => {
    // 1a. 顯式 configuredPort 優先於執行中程序與高號段
    const explicit = await resolveCdpPort({
      configuredPort: 24567,
      runningProcessArgs:
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=59999",
      forLaunch: true,
    });
    expect(explicit).toEqual({
      port: 24567,
      cdpUrl: "http://127.0.0.1:24567",
      source: "configured",
    });

    // 1b. 環境變數 SIDECAR_CDP / CODEX_CDP_PORT 優先
    const fromEnvUrl = await resolveCdpPort({
      env: { SIDECAR_CDP: "http://127.0.0.1:29333/" },
      runningProcessArgs: "",
    });
    expect(fromEnvUrl).toEqual({
      port: 29333,
      cdpUrl: "http://127.0.0.1:29333",
      source: "configured",
    });

    // 1c. 已執行桌面版程序帶有 --remote-debugging-port 時自動採用
    const fromProcess = await resolveCdpPort({
      env: {},
      runningProcessArgs: [
        "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=58432 --other-flag",
      ],
      forLaunch: true,
    });
    expect(fromProcess).toEqual({
      port: 58432,
      cdpUrl: "http://127.0.0.1:58432",
      source: "running_process",
    });
    expect(
      parsePortFromCommandArgs(
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port 60123",
      ),
    ).toBe(60123);

    // 2. 啟動桌面版時（forLaunch: true）從高號段 58000–65000 尋找空閒埠
    const highPort = await resolveCdpPort({
      env: {},
      runningProcessArgs: "",
      forLaunch: true,
      isPortFree: async (port) => port === 58002,
    });
    expect(highPort).toEqual({
      port: 58002,
      cdpUrl: "http://127.0.0.1:58002",
      source: "high_port",
    });
    expect(highPort.port).toBeGreaterThanOrEqual(HIGH_PORT_MIN);
    expect(highPort.port).toBeLessThanOrEqual(HIGH_PORT_MAX);

    // 3a. 非啟動狀態且無設定與執行中程序參數時，退回保底預設值 19333
    const fallbackDefault = await resolveCdpPort({
      env: {},
      runningProcessArgs: "",
      forLaunch: false,
    });
    expect(fallbackDefault).toEqual({
      port: DEFAULT_CDP_PORT,
      cdpUrl: "http://127.0.0.1:19333",
      source: "default",
    });

    // 3b. 高號段全滿時退回保底預設值 19333
    const exhaustedHigh = await resolveCdpPort({
      env: {},
      runningProcessArgs: "",
      forLaunch: true,
      minPort: 58000,
      maxPort: 58005,
      isPortFree: async () => false,
    });
    expect(exhaustedHigh).toEqual({
      port: DEFAULT_CDP_PORT,
      cdpUrl: "http://127.0.0.1:19333",
      source: "default",
    });

    // 3c. isChatGPTAppCommand 只匹配真正的主程序路徑，不誤判含該字串的 shell 或 grep 命令
    expect(
      isChatGPTAppCommand(
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=19333",
      ),
    ).toBe(true);
    expect(
      isChatGPTAppCommand(
        '/bin/bash -c "grep ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=19999"',
      ),
    ).toBe(false);
  });

  test("高號段候選埠被真實 TCP 服務佔用時能自動跳過，且對主畫面數量為 0 或 >1 回傳明確階段錯誤", async () => {
    // 佔用一個真實高號段埠，確認 findFreeHighPort 跳過該佔用埠
    const occupiedServer = net.createServer();
    await new Promise((resolve) =>
      occupiedServer.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve),
    );
    const occupiedPort = occupiedServer.address().port;
    try {
      const chosenPort = await findFreeHighPort({
        min: occupiedPort,
        max: occupiedPort + 20,
      });
      expect(chosenPort).toBeGreaterThan(occupiedPort);
      expect(chosenPort).toBeLessThanOrEqual(occupiedPort + 20);
    } finally {
      await new Promise((resolve) => occupiedServer.close(resolve));
    }

    // 主畫面數量為 0
    const zeroPagesServer = await startMockCdpServer({ pageCount: 0 });
    try {
      let caught = null;
      try {
        await getRendererTarget({ cdpUrl: zeroPagesServer.cdpUrl });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ChatGPTDesktopError);
      expect(caught.stage).toBe("renderer_not_unique");
      expect(caught.retrySafe).toBe(true);
      expect(caught.details.pageCount).toBe(0);
      expect(caught.message).toContain("主 renderer 不唯一，找到 0 個");
    } finally {
      zeroPagesServer.stop();
    }

    // 主畫面數量為 2 (> 1)
    const twoPagesServer = await startMockCdpServer({ pageCount: 2 });
    try {
      let caught = null;
      try {
        await getRendererTarget({ cdpUrl: twoPagesServer.cdpUrl });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ChatGPTDesktopError);
      expect(caught.stage).toBe("renderer_not_unique");
      expect(caught.retrySafe).toBe(true);
      expect(caught.details.pageCount).toBe(2);
      expect(caught.message).toContain("主 renderer 不唯一，找到 2 個");
    } finally {
      twoPagesServer.stop();
    }
  });
});

describe("Ticket 01 — 模組解析（RpcPromise 排除與 app-initial 退回）與思考節點過濾", () => {
  test("優先載入 app-shared，遇到 [object RpcPromise] 假代理時跳過並自動退回 app-initial；回覆跳過 thought/reasoning", async () => {
    const mock = await startMockCdpServer({
      kind: "success",
      sharedRpcPromiseOnly: true,
      initialExportName: "fallbackInitClient",
      answer: "final assistant text only",
    });

    try {
      const probe = await probeClient({
        cdpUrl: mock.cdpUrl,
        env: { CODEX_ADVISOR_CLIENT_EXPORT: "fTt" },
      });
      expect(probe.ok).toBe(true);
      expect(probe.challengeOk).toBe(true);
      expect(probe.clientExport).toBe("fallbackInitClient");
      expect(probe.moduleUrl).toContain("/app-initial-");
      expect(probe.drifted).toBe(true);

      const chat = await sendConversation({
        cdpUrl: mock.cdpUrl,
        prompt: "Hello",
        model: THINKING_MODEL,
      });
      expect(chat.answer).toBe("final assistant text only");
      expect(chat.answer).not.toContain("internal thought");
      expect(chat.answer).not.toContain("internal reasoning");
      expect(chat.answer).not.toContain("unfinished draft");
      expect(chat.clientExport).toBe("fallbackInitClient");
    } finally {
      mock.stop();
    }
  });

  test("串流事件已含完成訊息時直接取答案（不發送 GET /conversation/{id}），並自動剝除 model_dil_v2 外層 <escape> 標籤", async () => {
    const mock = await startMockCdpServer({
      kind: "stream-complete",
      throwEmptyErrorOnConversationGet: true,
      answer: '<escape>{"findings":[]}</escape>',
    });
    try {
      const chat = await sendConversation({
        cdpUrl: mock.cdpUrl,
        prompt: "Return raw JSON",
        model: "gpt-6-thinking",
        effort: "high",
      });
      expect(chat.answer).toBe('{"findings":[]}');
      expect(chat.conversationId).toBe("conv-stream-456");
      expect(chat.usage).toEqual({
        prompt_tokens: 4,
        completion_tokens: 4,
        total_tokens: 8,
      });
      expect(mock.state.requests[0].supported_encodings).toEqual([]);
      expect(mock.state.reads).toEqual(["/ios/attestation_challenge"]);

      let overCapErr = null;
      try {
        await sendConversation({
          cdpUrl: mock.cdpUrl,
          prompt: "x".repeat(500001),
          model: "gpt-6-thinking",
        });
      } catch (err) {
        overCapErr = err;
      }
      expect(overCapErr).toBeInstanceOf(ChatGPTDesktopError);
      expect(overCapErr.stage).toBe("context_length_exceeded");
      expect(overCapErr.status).toBe(413);
      expect(overCapErr.retrySafe).toBe(true);
      expect(mock.state.requests.length).toBe(1);
    } finally {
      mock.stop();
    }
  });

  test("對話已建立但串流中斷時用對話編號讀回已寫完的答案，不啟動冷卻", async () => {
    const mock = await startMockCdpServer({ kind: "unusual", answer: "recovered answer" });
    try {
      const chat = await sendConversation({
        cdpUrl: mock.cdpUrl,
        prompt: "hi",
        model: "gpt-6-thinking",
        timeoutMs: 121000,
      });
      expect(chat.answer).toBe("recovered answer");
      expect(chat.conversationId).toBe("conv-unusual");
      expect(chat.outcome).toBe("recovered");
      expect(chat.recoverReads).toBe(1);
      expect(mock.state.reads).toContain("/conversation/conv-unusual");
      expect(globalThis.__magpieUnusualActivityUntil ?? 0).toBeLessThan(Date.now());
    } finally {
      mock.stop();
    }
  });

  test("對話已建立但期限內讀不到完成答案時回 unknown_send_state，不啟動冷卻", async () => {
    const mock = await startMockCdpServer({ kind: "unusual", emptyConversation: true });
    try {
      let err = null;
      try {
        await sendConversation({
          cdpUrl: mock.cdpUrl,
          prompt: "hi",
          model: "gpt-6-thinking",
          timeoutMs: 121000,
        });
      } catch (error) {
        err = error;
      }
      expect(err?.stage).toBe("unknown_send_state");
      expect(err?.retrySafe).toBe(false);
      expect(mock.state.reads.filter((r) => r.startsWith("/conversation/")).length).toBeGreaterThan(0);
      expect(globalThis.__magpieUnusualActivityUntil ?? 0).toBeLessThan(Date.now());
    } finally {
      mock.stop();
    }
  });

  test("沒有建立對話就被 403 拒收時回 429 並冷卻 3 分鐘，不讀對話", async () => {
    const mock = await startMockCdpServer({ kind: "rejected" });
    try {
      let err = null;
      try {
        await sendConversation({ cdpUrl: mock.cdpUrl, prompt: "hi", model: "gpt-6-thinking" });
      } catch (error) {
        err = error;
      }
      expect(err?.status).toBe(429);
      expect(err?.stage).toBe("rate_limited");
      expect(mock.state.reads.filter((r) => r.startsWith("/conversation/")).length).toBe(0);
      const remaining = globalThis.__magpieUnusualActivityUntil - Date.now();
      expect(remaining).toBeGreaterThan(170 * 1000);
      expect(remaining).toBeLessThanOrEqual(180 * 1000);
    } finally {
      globalThis.__magpieUnusualActivityUntil = 0;
      resetUnusualActivityCooldown();
      mock.stop();
    }
  });

  test("listModels 動態讀取模型目錄並全數標記 tool_call: false", async () => {
    const mock = await startMockCdpServer({ kind: "success" });
    try {
      const { models } = await listModels({ cdpUrl: mock.cdpUrl });
      expect(models.length).toBe(3);
      for (const model of models) {
        expect(model.tool_call).toBe(false);
        expect(model.input_modalities).toEqual(["text"]);
        expect(model.output_modalities).toEqual(["text"]);
      }
    } finally {
      mock.stop();
    }
  });

  test("preferredClientExports 預設優先 Ymr/fTt，併發 listModels/probeClient 自動合併單一評估，且 WebSocket 已連線後的評估逾時標記為 renderer_timeout", async () => {
    expect(preferredClientExports({})).toEqual(["Ymr", "fTt"]);
    expect(preferredClientExports({ CODEX_ADVISOR_CLIENT_EXPORT: "fTt" })).toEqual([
      "fTt",
    ]);

    const mock = await startMockCdpServer({
      kind: "success",
      exportName: "Ymr",
    });
    try {
      const batch = await Promise.all(
        Array.from({ length: 8 }, () => listModels({ cdpUrl: mock.cdpUrl })),
      );
      expect(mock.state.evaluateCount).toBe(1);
      for (const item of batch) {
        expect(item.models.length).toBe(3);
        expect(item.clientExport).toBe("Ymr");
      }
      batch[0].models[0].name = "mutated";
      expect(batch[1].models[0].name).not.toBe("mutated");
    } finally {
      mock.stop();
    }

    const hangMock = await startMockCdpServer({ hangForever: true });
    try {
      let caught = null;
      try {
        await listModels({ cdpUrl: hangMock.cdpUrl, timeoutMs: 80 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ChatGPTDesktopError);
      expect(caught.stage).toBe("renderer_timeout");
      expect(caught.details.wsOpened).toBe(true);
    } finally {
      hangMock.stop();
    }
  });
});

describe("Ticket 01 — 多輪對話與系統提示折疊、非文字附件送出前拒絕", () => {
  test("多輪對話與系統提示整理為標示清楚的文字上下文送出", async () => {
    const mock = await startMockCdpServer({ kind: "success" });
    try {
      await sendConversation({
        cdpUrl: mock.cdpUrl,
        model: THINKING_MODEL,
        messages: [
          { role: "system", content: "You are a concise architect." },
          { role: "user", content: [{ type: "text", text: "First question" }] },
          { role: "assistant", content: "First reply" },
          { role: "user", content: "Follow-up question" },
        ],
      });

      expect(mock.state.requests.length).toBe(1);
      const sentPrompt = mock.state.requests[0].messages[0].content.parts[0];
      expect(sentPrompt).toBe(
        "[System]\nYou are a concise architect.\n\n[User]\nFirst question\n\n[Assistant]\nFirst reply\n\n[User]\nFollow-up question",
      );
      expect(mock.state.requests[0].is_do_not_remember).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("包含圖片、音訊或非文字附件時，在送出前直接拒絕（400）且不發送任何遠端請求", async () => {
    const mock = await startMockCdpServer({ kind: "success" });
    try {
      const invalidCases = [
        [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
        [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "base64", format: "wav" } }] }],
        [{ role: "user", content: "see file", attachments: [{ id: "file-123" }] }],
      ];

      for (const messages of invalidCases) {
        let caught = null;
        try {
          await sendConversation({
            cdpUrl: mock.cdpUrl,
            model: THINKING_MODEL,
            messages,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ChatGPTDesktopError);
        expect(caught.stage).toBe("unsupported_input");
        expect(caught.status).toBe(400);
        expect(caught.retrySafe).toBe(true);
      }

      // 驗證完全沒有打到遠端 CDP HTTP 或 WebSocket
      expect(mock.state.httpListCount).toBe(0);
      expect(mock.state.evaluateCount).toBe(0);
      expect(mock.state.requests.length).toBe(0);
    } finally {
      mock.stop();
    }
  });
});

describe("Ticket 01 — 自動降級 Instant 開關（涵蓋 Pro 與 Thinking）與防誤判保護", () => {
  test("自動降級關閉（預設）時，遇 model_cap_exceeded 直接回報配額錯誤且不重送", async () => {
    const mock = await startMockCdpServer({ kind: "quota" });
    try {
      for (const model of [THINKING_MODEL, PRO_MODEL]) {
        let caught = null;
        try {
          await sendConversation({
            cdpUrl: mock.cdpUrl,
            model,
            prompt: "test prompt",
            instantFallback: false,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ChatGPTDesktopError);
        expect(caught.stage).toBe("quota_exceeded");
        expect(caught.retrySafe).toBe(true);
      }
      expect(mock.state.requests.map((r) => r.model)).toEqual([
        THINKING_MODEL,
        PRO_MODEL,
      ]);
    } finally {
      mock.stop();
    }
  });

  test("自動降級開啟時，不論請求 Thinking 或 Pro 模型，遇 model_cap_exceeded 且無活動皆自動改送同版本非工作模式 Instant 一次", async () => {
    const mock = await startMockCdpServer({ kind: "quota" });
    try {
      const thinkingRes = await sendConversation({
        cdpUrl: mock.cdpUrl,
        model: THINKING_MODEL,
        effort: "extended",
        prompt: "thinking prompt",
        instantFallback: true,
      });
      expect(thinkingRes.answer).toBe(DEFAULT_ANSWER);
      expect(thinkingRes.fallbackUsed).toBe(true);
      expect(thinkingRes.requestedModel).toBe(INSTANT_MODEL);

      const proRes = await sendConversation({
        cdpUrl: mock.cdpUrl,
        model: PRO_MODEL,
        effort: "extended",
        prompt: "pro prompt",
        instantFallback: true,
      });
      expect(proRes.answer).toBe(DEFAULT_ANSWER);
      expect(proRes.fallbackUsed).toBe(true);
      expect(proRes.requestedModel).toBe(INSTANT_MODEL);

      expect(mock.state.requests.map((r) => r.model)).toEqual([
        THINKING_MODEL,
        INSTANT_MODEL,
        PRO_MODEL,
        INSTANT_MODEL,
      ]);
      // Instant 重送時不帶 thinking_effort
      expect(mock.state.requests[0].thinking_effort).toBe("extended");
      expect(mock.state.requests[1].thinking_effort).toBeUndefined();
      expect(mock.state.requests[2].thinking_effort).toBe("standard");
      expect(mock.state.requests[3].thinking_effort).toBeUndefined();
    } finally {
      mock.stop();
    }
  });

  test("OpenAI 標準 reasoning_effort（low/medium/high/minimal/xhigh）自動正規化為 ChatGPT Desktop thinking_effort，且 -pro 固定為 standard", async () => {
    expect(normalizeThinkingEffort("low", THINKING_MODEL)).toBe("min");
    expect(normalizeThinkingEffort("minimal", THINKING_MODEL)).toBe("min");
    expect(normalizeThinkingEffort("medium", THINKING_MODEL)).toBe("standard");
    expect(normalizeThinkingEffort("high", THINKING_MODEL)).toBe("extended");
    expect(normalizeThinkingEffort("xhigh", THINKING_MODEL)).toBe("max");
    expect(normalizeThinkingEffort("high", PRO_MODEL)).toBe("standard");
    expect(normalizeThinkingEffort("", THINKING_MODEL)).toBe("");

    const mock = await startMockCdpServer({ kind: "success" });
    try {
      await sendConversation({
        cdpUrl: mock.cdpUrl,
        model: THINKING_MODEL,
        effort: "low",
        prompt: "low effort prompt",
      });
      await sendConversation({
        cdpUrl: mock.cdpUrl,
        model: THINKING_MODEL,
        effort: "high",
        prompt: "high effort prompt",
      });
      expect(mock.state.requests.map((r) => r.thinking_effort)).toEqual([
        "min",
        "extended",
      ]);
    } finally {
      mock.stop();
    }
  });

  test("目錄將工作模式模型標為 instant、或已有對話活動／外層非配額錯誤碼時，絕不降級重送", async () => {
    for (const scenario of [
      { kind: "quota", proAsInstant: true, expectRetrySafe: true },
      { kind: "quota", workModeInstant: true, expectRetrySafe: true },
      { kind: "quota", noInstant: true, expectRetrySafe: true },
      { kind: "rate", expectRetrySafe: false },
      { kind: "conflicting-code", expectRetrySafe: false },
      { kind: "accepted-quota", expectRetrySafe: false },
      { kind: "partial-quota", expectRetrySafe: false },
    ]) {
      const mock = await startMockCdpServer(scenario);
      try {
        let caught = null;
        try {
          await sendConversation({
            cdpUrl: mock.cdpUrl,
            model: THINKING_MODEL,
            prompt: "test",
            instantFallback: true,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ChatGPTDesktopError);
        expect(caught.retrySafe).toBe(scenario.expectRetrySafe);
        expect(mock.state.requests.length).toBe(1);
      } finally {
        mock.stop();
      }
    }
  });
});

describe("Ticket 01 — 逾時、斷線、無完成訊息與 AbortSignal 取消時立即關閉 WebSocket 且不重送", () => {
  test("呼叫端觸發 AbortSignal 時立即關閉 WebSocket 並標記為 unknown_send_state (retrySafe: false)", async () => {
    const mock = await startMockCdpServer({ hangForever: true });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 80);

      let caught = null;
      try {
        await sendConversation({
          cdpUrl: mock.cdpUrl,
          model: THINKING_MODEL,
          prompt: "abort me",
          signal: controller.signal,
          timeoutMs: 10000,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ChatGPTDesktopError);
      expect(caught.stage).toBe("unknown_send_state");
      expect(caught.retrySafe).toBe(false);
      expect(caught.details.aborted).toBe(true);

      await mock.waitForWsClose(1);
      expect(mock.state.wsClosedCount).toBe(1);
      expect(mock.state.evaluateCount).toBe(1);
    } finally {
      mock.stop();
    }
  });

  test("送出後逾時、連線中斷、無效 JSON 或 premature 串流皆立即關閉 WebSocket 且 retrySafe: false", async () => {
    for (const scenario of [
      { hangForever: true, timeoutMs: 120 },
      { closeOnEvaluate: true, timeoutMs: 2000 },
      { invalidCdpReply: true, timeoutMs: 2000 },
      { kind: "premature", timeoutMs: 2000 },
      { kind: "success", emptyConversation: true, timeoutMs: 2000 },
    ]) {
      const mock = await startMockCdpServer(scenario);
      try {
        let caught = null;
        try {
          await sendConversation({
            cdpUrl: mock.cdpUrl,
            model: THINKING_MODEL,
            prompt: "test",
            timeoutMs: scenario.timeoutMs,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ChatGPTDesktopError);
        expect(caught.stage).toBe("unknown_send_state");
        expect(caught.retrySafe).toBe(false);
        await mock.waitForWsClose(1);
        expect(mock.state.evaluateCount).toBe(1);
      } finally {
        mock.stop();
      }
    }
  });
});

describe("Ticket 01 — CLI 入口 (--probe、退出碼 0/1/3、SIDECAR_WEB_RETRY_UNSAFE 與降級紀錄容錯)", () => {
  const execCliChild = (args, { input, env } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, ...args], {
        env: env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({ status, stdout, stderr });
      });
      if (input !== undefined) {
        child.stdin.write(input);
      }
      child.stdin.end();
    });

  test("CLI 子程序 --probe 輸出包含 ok, challengeOk, clientExport, preferred, drifted，且斷線時回退出碼 1", async () => {
    const mock = await startMockCdpServer({
      kind: "success",
      exportName: "newExportName",
    });
    try {
      const okProc = await execCliChild(["--probe"], {
        env: {
          ...process.env,
          SIDECAR_CDP: mock.cdpUrl,
          CODEX_ADVISOR_CLIENT_EXPORT: "fTt",
        },
      });
      expect(okProc.status).toBe(0);
      const parsed = JSON.parse(okProc.stdout.trim());
      expect(parsed.ok).toBe(true);
      expect(parsed.challengeOk).toBe(true);
      expect(parsed.clientExport).toBe("newExportName");
      expect(parsed.preferred).toEqual(["fTt"]);
      expect(parsed.drifted).toBe(true);
    } finally {
      mock.stop();
    }

    // 關閉後再執行 --probe 應回退出碼 1 並印出 {"ok":false,"error":...}
    const failProc = await execCliChild(["--probe"], {
      env: {
        ...process.env,
        SIDECAR_CDP: "http://127.0.0.1:19",
      },
    });
    expect(failProc.status).toBe(1);
    const failParsed = JSON.parse(failProc.stdout.trim());
    expect(failParsed.ok).toBe(false);
    expect(typeof failParsed.error).toBe("string");
  });

  test("CLI 送出前失敗回退出碼 1；送出後狀態不明回退出碼 3 並印出 SIDECAR_WEB_RETRY_UNSAFE", async () => {
    // 1. 空 stdin → 退出碼 1
    let stdout = "";
    let stderr = "";
    const emptyCode = await runCli([], {
      stdinText: "   \n  ",
      writeStdout: (s) => {
        stdout += s;
      },
      writeStderr: (s) => {
        stderr += s;
      },
    });
    expect(emptyCode).toBe(1);
    expect(stderr).toContain("stdin 沒有內容");

    // 2. 送出前 CDP 無法連線 → 退出碼 1
    stdout = "";
    stderr = "";
    const preSendCode = await runCli([THINKING_MODEL], {
      stdinText: "hello",
      cdpUrl: "http://127.0.0.1:19",
      writeStdout: (s) => {
        stdout += s;
      },
      writeStderr: (s) => {
        stderr += s;
      },
    });
    expect(preSendCode).toBe(1);
    expect(stderr).not.toContain("SIDECAR_WEB_RETRY_UNSAFE");

    // 3. 送出後 premature 中斷 → 退出碼 3 + SIDECAR_WEB_RETRY_UNSAFE
    const mock = await startMockCdpServer({ kind: "premature" });
    try {
      const unsafeProc = await execCliChild([THINKING_MODEL], {
        input: "question text",
        env: {
          ...process.env,
          SIDECAR_CDP: mock.cdpUrl,
        },
      });
      expect(unsafeProc.status).toBe(3);
      expect(unsafeProc.stdout).toBe("");
      expect(unsafeProc.stderr).toContain("SIDECAR_WEB_RETRY_UNSAFE");
      expect(mock.state.requests.length).toBe(1);
    } finally {
      mock.stop();
    }
  });

  test("CLI 降級紀錄防護（拒絕 symlink/hardlink/fifo）與完成後寫檔失敗僅印告警不重送（回退出碼 0）", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-cdp-cli-"));
    try {
      // 1. 降級前若 log 目標為 symlink、hardlink 或 fifo，拒絕寫入且不啟動 Instant 重送
      const fifoPath = path.join(tmpDir, "fallback-fifo.jsonl");
      let fifoCreated = false;
      try {
        const mkfifoProc = Bun.spawnSync(["mkfifo", fifoPath]);
        fifoCreated = mkfifoProc.exitCode === 0;
      } catch {
        fifoCreated = false;
      }
      const unsafeKinds = fifoCreated
        ? ["symlink", "hardlink", "fifo"]
        : ["symlink", "hardlink"];

      for (const linkKind of unsafeKinds) {
        const mock = await startMockCdpServer({ kind: "quota" });
        const targetFile = path.join(tmpDir, `untouched-${linkKind}.txt`);
        const logFile =
          linkKind === "fifo"
            ? fifoPath
            : path.join(tmpDir, `fallback-${linkKind}.jsonl`);
        if (linkKind !== "fifo") {
          fs.writeFileSync(targetFile, "unchanged");
          if (linkKind === "symlink") {
            fs.symlinkSync(targetFile, logFile);
          } else {
            fs.linkSync(targetFile, logFile);
          }
        }

        try {
          let out = "";
          let err = "";
          const code = await runCli([THINKING_MODEL], {
            stdinText: "secret prompt",
            cdpUrl: mock.cdpUrl,
            logPath: logFile,
            writeStdout: (s) => {
              out += s;
            },
            writeStderr: (s) => {
              err += s;
            },
          });
          expect(code).toBe(1);
          expect(out).toBe("");
          expect(err).toContain("未啟動 Instant：無法記錄降級");
          expect(mock.state.requests.length).toBe(1);
          if (linkKind !== "fifo") {
            expect(fs.readFileSync(targetFile, "utf8")).toBe("unchanged");
          }
        } finally {
          mock.stop();
        }
      }

      // 2. 正常降級：記錄 fallback_started 與 fallback_completed，且不包含 prompt 或 answer
      const okMock = await startMockCdpServer({ kind: "quota" });
      const normalLog = path.join(tmpDir, "normal-fallback.jsonl");
      try {
        let out = "";
        let err = "";
        const code = await runCli([THINKING_MODEL], {
          stdinText: "my private prompt",
          cdpUrl: okMock.cdpUrl,
          logPath: normalLog,
          writeStdout: (s) => {
            out += s;
          },
          writeStderr: (s) => {
            err += s;
          },
        });
        expect(code).toBe(0);
        expect(out).toBe(`${DEFAULT_ANSWER}\n`);
        expect(err).toContain("Thinking 配額已拒絕，改用 Instant 一次。");
        const rawLog = fs.readFileSync(normalLog, "utf8");
        const lines = rawLog
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        expect(lines.map((l) => l.event)).toEqual([
          "fallback_started",
          "fallback_completed",
        ]);
        expect(rawLog).not.toContain("my private prompt");
        expect(rawLog).not.toContain(DEFAULT_ANSWER);
      } finally {
        okMock.stop();
      }

      // 3. 降級成功收到回覆後若寫入 fallback_completed 失敗（例如中途將 log 換成 symlink），
      // 只印出告警而不把已完成的請求判成失敗重送（仍印出答案並回退出碼 0）
      const completedLog = path.join(tmpDir, "post-reply-fail.jsonl");
      const symlinkTarget = path.join(tmpDir, "dummy.txt");
      fs.writeFileSync(symlinkTarget, "dummy");

      const postFailMock = await startMockCdpServer({ kind: "quota" });
      try {
        // 當第二次請求（Instant）送達伺服器時，將 log 檔替換為 symlink，使 fallback_completed 寫入失敗
        const origFetch = globalThis.fetch;
        let callIdx = 0;
        const customFetch = async (url, opts) => {
          callIdx += 1;
          if (callIdx === 2) {
            if (fs.existsSync(completedLog)) fs.unlinkSync(completedLog);
            fs.symlinkSync(symlinkTarget, completedLog);
          }
          return origFetch(url, opts);
        };

        let out = "";
        let err = "";
        const code = await runCli([THINKING_MODEL], {
          stdinText: "prompt before post-write fail",
          cdpUrl: postFailMock.cdpUrl,
          logPath: completedLog,
          fetchImpl: customFetch,
          writeStdout: (s) => {
            out += s;
          },
          writeStderr: (s) => {
            err += s;
          },
        });
        expect(code).toBe(0);
        expect(out).toBe(`${DEFAULT_ANSWER}\n`);
        expect(err).toContain("Instant 降級結果未能寫入紀錄：");
        expect(postFailMock.state.requests.length).toBe(2);
      } finally {
        postFailMock.stop();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI 支援 --render-expression、漂移告警與 SIDECAR_INSTANT_FALLBACK 控制", async () => {
    for (const kind of ["probe", "models", "chat"]) {
      let out = "";
      const code = await runCli(
        kind === "chat"
          ? [
              "--render-expression",
              "chat",
              JSON.stringify({
                prompt: "hi",
                model: THINKING_MODEL,
                effort: "standard",
                instantFallback: false,
              }),
            ]
          : ["--render-expression", kind],
        {
          writeStdout: (s) => {
            out += s;
          },
        },
      );
      expect(code).toBe(0);
      expect(out).toContain("isChatGPTClient");
      expect(out).toContain("[object RpcPromise]");
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-cdp-env-"));
    try {
      const logPath = path.join(tmpDir, "fallback.jsonl");
      const mock = await startMockCdpServer({
        kind: "quota",
        exportName: "driftedExportZ",
      });
      try {
        // 預設 CLI 模式下，gpt-6-pro 不降級（相容既有 test_pro_model_is_not_downgraded）
        let out1 = "";
        let err1 = "";
        const code1 = await runCli([], {
          stdinText: "pro question",
          cdpUrl: mock.cdpUrl,
          logPath,
          env: {
            SIDECAR_WEB_MODEL: PRO_MODEL,
            CODEX_ADVISOR_CLIENT_EXPORT: "fTt",
          },
          writeStdout: (s) => {
            out1 += s;
          },
          writeStderr: (s) => {
            err1 += s;
          },
        });
        expect(code1).toBe(1);
        expect(out1).toBe("");
        expect(mock.state.requests.map((r) => r.model)).toEqual([PRO_MODEL]);

        // 設定 SIDECAR_INSTANT_FALLBACK=all 後，Pro 模型也自動降級 Instant 並印出漂移提示
        mock.state.requests.length = 0;
        let out2 = "";
        let err2 = "";
        const code2 = await runCli([], {
          stdinText: "pro question with all fallback",
          cdpUrl: mock.cdpUrl,
          logPath,
          env: {
            SIDECAR_WEB_MODEL: PRO_MODEL,
            CODEX_ADVISOR_CLIENT_EXPORT: "fTt",
            SIDECAR_INSTANT_FALLBACK: "all",
          },
          writeStdout: (s) => {
            out2 += s;
          },
          writeStderr: (s) => {
            err2 += s;
          },
        });
        expect(code2).toBe(0);
        expect(out2).toBe(`${DEFAULT_ANSWER}\n`);
        expect(err2).toContain("注意：client export 已從 fTt 漂移到 driftedExportZ");
        expect(mock.state.requests.map((r) => r.model)).toEqual([
          PRO_MODEL,
          INSTANT_MODEL,
        ]);
      } finally {
        mock.stop();
      }

      // 送出後若讀取對話拋出空訊息 Error("")，必須判為 unknown_send_state（CLI exit 3），不可誤判成功
      const emptyErrMock = await startMockCdpServer({
        kind: "success",
        throwEmptyErrorOnConversationGet: true,
      });
      try {
        let outEmpty = "";
        let errEmpty = "";
        const codeEmpty = await runCli([THINKING_MODEL], {
          stdinText: "question",
          cdpUrl: emptyErrMock.cdpUrl,
          logPath,
          writeStdout: (s) => {
            outEmpty += s;
          },
          writeStderr: (s) => {
            errEmpty += s;
          },
        });
        expect(codeEmpty).toBe(3);
        expect(outEmpty).toBe("");
        expect(errEmpty).toContain("SIDECAR_WEB_RETRY_UNSAFE");
        expect(emptyErrMock.state.requests.length).toBe(1);
      } finally {
        emptyErrMock.stop();
      }

      // 若目錄中僅其他版本有 Instant，不得跨版本降級送出
      const crossVerMock = await startMockCdpServer({
        kind: "quota",
        crossVersionOnlyInstant: true,
      });
      try {
        await expect(
          sendConversation({
            prompt: "test cross version",
            model: THINKING_MODEL,
            instantFallback: true,
            cdpUrl: crossVerMock.cdpUrl,
          }),
        ).rejects.toMatchObject({
          stage: "quota_exceeded",
          retrySafe: true,
        });
        expect(crossVerMock.state.requests.map((r) => r.model)).toEqual([
          THINKING_MODEL,
        ]);
      } finally {
        crossVerMock.stop();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
