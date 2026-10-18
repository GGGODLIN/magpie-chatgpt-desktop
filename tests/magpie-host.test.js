import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { HIGH_PORT_MAX, HIGH_PORT_MIN, RENDERER_URL } from "../src/core.js";
import chatgptDesktopPlugin from "../src/index.js";

describe("Ticket 02 — 真實 Magpie Bun 外掛宿主整合測試", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const PLUGIN_ROOT = path.resolve(__dirname, "..");
  const MAGPIE_HOST_PATH = [
    path.resolve(PLUGIN_ROOT, "../magpie/internal/plugin/host.js"),
    path.resolve(PLUGIN_ROOT, "../../../magpie/internal/plugin/host.js"),
  ].find((candidate) => fs.existsSync(candidate));

  const THINKING_MODEL = "gpt-5-6-thinking";
  const PRO_MODEL = "gpt-6-pro";
  const INSTANT_MODEL = "gpt-5-6-instant";
  const DEFAULT_ANSWER = "Verified answer from ChatGPT Desktop";

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

  const startMockCdpServer = async (initialScenario = {}) => {
    let scenario = { ...initialScenario };
    const state = {
      httpListCount: 0,
      evaluateCount: 0,
      requests: [],
      reads: [],
    };

    const server = Bun.serve({
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
        async message(ws, rawMessage) {
          state.evaluateCount += 1;
          const cmd = JSON.parse(String(rawMessage));
          const expression = cmd.params.expression;
          const catalog = scenario.catalog ?? DEFAULT_CATALOG;
          const answer = scenario.answer ?? DEFAULT_ANSWER;
          const exportName = scenario.exportName ?? "fTt";

          const moduleSource = scenario.noClientExports
            ? `  export default { nope: true };`
            : [
                `  const scenario = ${JSON.stringify(scenario)};`,
                `  const catalog = ${JSON.stringify(catalog)};`,
                `  const answer = ${JSON.stringify(answer)};`,
                `  export const ${exportName} = {`,
                `    safeGet: async (reqPath) => {`,
                `      globalThis.__hostTestReads.push(reqPath);`,
                `      if (reqPath === "/ios/attestation_challenge") {`,
                `        if (scenario.attestationFails) {`,
                `          throw new Error("401 unauthorized token_secret_xyz");`,
                `        }`,
                `        return { attestation_challenge: "secret-attestation-token-999" };`,
                `      }`,
                `      if (reqPath.startsWith("/models")) {`,
                `        return catalog;`,
                `      }`,
                `      if (scenario.emptyConversation) {`,
                `        return { mapping: {} };`,
                `      }`,
                `      const requestedSlug = globalThis.__hostTestRequests.at(-1)?.model ?? null;`,
                `      return {`,
                `        mapping: {`,
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
                `      globalThis.__hostTestRequests.push(body);`,
                `      const quota = { detail: { code: "model_cap_exceeded", message: "Allowance exhausted" } };`,
                `      if (scenario.kind === "premature") {`,
                `        init.onPrematureTermination();`,
                `      } else if (scenario.kind === "quota" && !body.model.endsWith("-instant")) {`,
                `        init.onError(quota);`,
                `      } else {`,
                `        init.onComplete({ conversation_id: "conv-host-123" });`,
                `      }`,
                `      return "stream-handle";`,
                `    },`,
                `    cancelStream: () => {},`,
                `  };`,
              ].join("\n");

          const sharedUrl =
            "data:text/javascript," +
            encodeURIComponent(moduleSource + "\n//") +
            `#/assets/app-shared-${crypto.randomUUID()}.js`;

          const resourceEntries = scenario.noModules ? [] : [{ name: sharedUrl }];
          const prevPerformance = globalThis.performance;
          const prevDocument = globalThis.document;
          const requests = [];
          const reads = [];
          globalThis.__hostTestRequests = requests;
          globalThis.__hostTestReads = reads;
          globalThis.performance = {
            getEntriesByType: () => resourceEntries,
          };
          globalThis.document = {
            querySelectorAll: () => [],
          };

          let evalValue;
          try {
            const AsyncFunction = Object.getPrototypeOf(
              async function () {},
            ).constructor;
            const fn = new AsyncFunction(`return await ${expression};`);
            evalValue = await fn();
          } finally {
            globalThis.performance = prevPerformance;
            globalThis.document = prevDocument;
            delete globalThis.__hostTestRequests;
            delete globalThis.__hostTestReads;
          }

          state.requests.push(...requests);
          state.reads.push(...reads);

          ws.send(
            JSON.stringify({
              id: cmd.id,
              result: {
                result: {
                  type: "object",
                  value: evalValue,
                },
              },
            }),
          );
        },
      },
    });

    return {
      port: server.port,
      cdpUrl: `http://127.0.0.1:${server.port}`,
      state,
      setScenario: (next) => {
        scenario = { ...scenario, ...next };
      },
      stop: () => server.stop(true),
    };
  };

  const startMagpieHost = async ({ stateData, options = {} } = {}) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-host-test-"));
    const authPath = path.join(tmpDir, "plugin-auth.json");
    const stateFile = path.join(tmpDir, "desktop-state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          platform: "darwin",
          appInstalled: true,
          running: false,
          debuggingPort: null,
          cdpUrl: null,
          launchedCdpUrl: null,
          occupiedPorts: [],
          launches: [],
          quits: 0,
          ...stateData,
        },
        null,
        2,
      ),
    );

    const child = spawn(process.execPath, [MAGPIE_HOST_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rawStdoutLines = [];
    const nonJsonStdoutLines = [];
    const events = [];
    const pending = new Map();
    const fetchStreams = new Map();
    let nextId = 1;

    const rl = readline.createInterface({
      input: child.stdout,
      terminal: false,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      rawStdoutLines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
        if (!msg || typeof msg !== "object" || (!("id" in msg) && !("event" in msg))) {
          nonJsonStdoutLines.push(line);
          return;
        }
      } catch {
        nonJsonStdoutLines.push(line);
        return;
      }

      if ("id" in msg && (msg.event === "head" || msg.event === "chunk")) {
        const stream = fetchStreams.get(msg.id);
        if (!stream) return;
        if (msg.event === "head") {
          stream.status = msg.status;
          stream.headers = msg.headers ?? {};
        } else if (msg.event === "chunk") {
          const buf = Buffer.from(msg.data ?? "", "base64");
          stream.chunks.push(buf);
          child.stdin.write(
            JSON.stringify({
              method: "credit",
              params: { id: msg.id, n: buf.length + 2048 },
            }) + "\n",
          );
        }
        return;
      }

      if ("id" in msg) {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        const stream = fetchStreams.get(msg.id);
        fetchStreams.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else if (stream) {
          waiter.resolve({
            status: stream.status,
            headers: stream.headers,
            body: Buffer.concat(stream.chunks).toString("utf8"),
          });
        } else {
          waiter.resolve(msg.result);
        }
        return;
      }

      events.push(msg);
    });

    const call = (method, params = {}) => {
      const id = nextId++;
      if (method === "fetch") {
        fetchStreams.set(id, { status: 0, headers: {}, chunks: [] });
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    };

    const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const updateState = (patch) => {
      const cur = readState();
      fs.writeFileSync(stateFile, JSON.stringify({ ...cur, ...patch }, null, 2));
    };

    const initResult = await call("init", {
      authPath,
      directory: PLUGIN_ROOT,
      config: {},
      options,
      plugins: [
        {
          spec: "magpie-chatgpt-desktop",
          target: PLUGIN_ROOT,
          options: { stateFile },
        },
      ],
    });

    const close = async () => {
      rl.close();
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          resolve();
        }, 2000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };

    return {
      initResult,
      call,
      readState,
      updateState,
      rawStdoutLines,
      nonJsonStdoutLines,
      events,
      close,
    };
  };
  test("1. 透過真實宿主載入外掛完成 init 與 providers 查詢，宣告 maxConcurrency: 1 且不汙染 stdout JSON-RPC 通道", async () => {
    const mock = await startMockCdpServer({ kind: "success" });
    const host = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: mock.port,
        cdpUrl: mock.cdpUrl,
      },
    });

    try {
      expect(host.initResult).toEqual({
        plugins: [
          {
            spec: "magpie-chatgpt-desktop",
            provides: ["chatgpt-desktop"],
          },
        ],
      });

      const providersList = await host.call("providers");
      expect(Array.isArray(providersList)).toBe(true);
      const provider = providersList.find((p) => p.id === "chatgpt-desktop");
      expect(provider).toBeDefined();
      expect(provider.name).toBe("ChatGPT Desktop");
      expect(provider.maxConcurrency).toBe(1);
      expect(provider.usage).toBe(true);
      expect(provider.options).toEqual([
        expect.objectContaining({
          key: "instant_fallback",
          default: false,
        }),
      ]);
      expect(host.nonJsonStdoutLines).toEqual([]);
      expect(host.rawStdoutLines.length).toBeGreaterThanOrEqual(2);
    } finally {
      await host.close();
      mock.stop();
    }
  });

  test("2. 點選登入依桌面版狀態走完三條分支：(1) 已開埠直接登入 (2) 未執行自動帶高號段空閒埠啟動 (3) 已執行未開埠跳選單確認重啟或取消", async () => {
    const mock = await startMockCdpServer({ kind: "success" });

    // 分支 (1): 桌面版已執行且除錯埠已開啟、通過裝置驗證 → 直接登入
    const hostBranch1 = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: mock.port,
        cdpUrl: mock.cdpUrl,
      },
    });
    try {
      const prompt1 = await hostBranch1.call("prompt", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      expect(prompt1.prompt).toBeNull();

      const auth1 = await hostBranch1.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      const cb1 = await hostBranch1.call("callback", {
        session: auth1.session,
      });
      expect(cb1).toEqual({
        ok: true,
        provider: "chatgpt-desktop",
        account: "chatgpt-desktop",
      });
      const st1 = hostBranch1.readState();
      expect(st1.quits).toBe(0);
      expect(st1.launches.length).toBe(0);
    } finally {
      await hostBranch1.close();
    }

    // 分支 (2): 桌面版未執行 → 自動尋找高號段 (58000–65000) 空閒埠啟動並完成驗證
    const hostBranch2 = await startMagpieHost({
      stateData: {
        running: false,
        debuggingPort: null,
        cdpUrl: null,
        launchedCdpUrl: mock.cdpUrl,
        occupiedPorts: [58000],
      },
    });
    try {
      const prompt2 = await hostBranch2.call("prompt", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      expect(prompt2.prompt).toBeNull();

      const auth2 = await hostBranch2.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      const cb2 = await hostBranch2.call("callback", {
        session: auth2.session,
      });
      expect(cb2).toEqual({
        ok: true,
        provider: "chatgpt-desktop",
        account: "chatgpt-desktop",
      });

      const st2 = hostBranch2.readState();
      expect(st2.quits).toBe(0);
      expect(st2.launches.length).toBe(1);
      expect(st2.launches[0].port).toBeGreaterThanOrEqual(HIGH_PORT_MIN);
      expect(st2.launches[0].port).toBeLessThanOrEqual(HIGH_PORT_MAX);
      expect(st2.launches[0].port).not.toBe(58000);
      expect(st2.launches[0].args).toEqual([
        `--remote-debugging-port=${st2.launches[0].port}`,
      ]);
    } finally {
      await hostBranch2.close();
    }

    // 分支 (3): 桌面版已執行但未開除錯埠 → 透過 ask 呈現確認重啟選單
    const hostBranch3 = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: null,
        cdpUrl: null,
        launchedCdpUrl: mock.cdpUrl,
      },
    });
    try {
      const prompt3 = await hostBranch3.call("prompt", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      expect(prompt3.prompt).not.toBeNull();
      expect(prompt3.prompt.type).toBe("select");
      expect(prompt3.prompt.key).toBe("restart_action");
      expect(prompt3.prompt.message).toContain("草稿");
      expect(prompt3.prompt.options.map((o) => o.value)).toEqual([
        "restart",
        "manual",
      ]);

      // 3a: 使用者選擇 manual（不自動重開）→ 不殺程序、回報失敗
      const promptAfterManual = await hostBranch3.call("prompt", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: { restart_action: "manual" },
      });
      expect(promptAfterManual.prompt).toBeNull();

      const authManual = await hostBranch3.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: { restart_action: "manual" },
      });
      const cbManual = await hostBranch3.call("callback", {
        session: authManual.session,
      });
      expect(cbManual.ok).toBe(false);
      expect(cbManual.error).toContain("未關閉執行中的 ChatGPT.app");
      const stManual = hostBranch3.readState();
      expect(stManual.quits).toBe(0);
      expect(stManual.launches.length).toBe(0);

      // 3b: 使用者選擇 restart（同意自動關閉並重開）→ 優雅退出後帶高號段空閒埠重開並完成登入
      const authRestart = await hostBranch3.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: { restart_action: "restart" },
      });
      const cbRestart = await hostBranch3.call("callback", {
        session: authRestart.session,
      });
      expect(cbRestart).toEqual({
        ok: true,
        provider: "chatgpt-desktop",
        account: "chatgpt-desktop",
      });
      const stRestart = hostBranch3.readState();
      expect(stRestart.quits).toBe(1);
      expect(stRestart.launches.length).toBe(1);
      expect(stRestart.launches[0].port).toBeGreaterThanOrEqual(HIGH_PORT_MIN);
      expect(stRestart.launches[0].port).toBeLessThanOrEqual(HIGH_PORT_MAX);

      // 非 macOS 或未安裝 ChatGPT.app 時回傳明確不支援錯誤
      hostBranch3.updateState({ platform: "linux", appInstalled: false });
      const authUnsupported = await hostBranch3.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      const cbUnsupported = await hostBranch3.call("callback", {
        session: authUnsupported.session,
      });
      expect(cbUnsupported.ok).toBe(false);
      expect(cbUnsupported.error).toContain("/Applications/ChatGPT.app");
      expect(hostBranch3.nonJsonStdoutLines).toEqual([]);
    } finally {
      await hostBranch3.close();
      mock.stop();
    }
  });

  test("3. 非登入流程（刷新模型清單、讀取 Usage 卡片、發送一般對話請求）遇桌面版未執行或除錯埠關閉時，直接回傳錯誤，絕不自動啟動、退出或重開程序", async () => {
    const mock = await startMockCdpServer({ kind: "success" });
    const host = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: mock.port,
        cdpUrl: mock.cdpUrl,
      },
    });

    try {
      // 先完成登入以建立帳號紀錄
      const auth = await host.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      const cb = await host.call("callback", { session: auth.session });
      expect(cb.ok).toBe(true);

      // 分別測試「桌面版未執行」與「桌面版已執行但除錯埠關閉」兩種狀態
      for (const disconnectedState of [
        { running: false, debuggingPort: null, cdpUrl: null },
        { running: true, debuggingPort: null, cdpUrl: null },
      ]) {
        host.updateState(disconnectedState);

        // (a) 刷新模型清單
        const providersList = await host.call("providers");
        const p = providersList.find((item) => item.id === "chatgpt-desktop");
        expect(p.fellBack).toBe(true);
        expect(p.listError).toContain("Sign in");
        expect(p.models).toEqual([]);

        // (b) 讀取 Usage 卡片
        const usageRes = await host.call("usage", {
          provider: "chatgpt-desktop",
        });
        expect(usageRes.error).toContain("Sign in");

        // (c) 發送一般對話請求
        const fetchRes = await host.call("fetch", {
          provider: "chatgpt-desktop",
          model: THINKING_MODEL,
          url: "http://127.0.0.1/v1/chat/completions",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              model: THINKING_MODEL,
              messages: [{ role: "user", content: "hello" }],
            }),
          ).toString("base64"),
        });
        expect(fetchRes.status).toBe(503);

        // 驗證絕未啟動、退出或重開桌面版程序
        const currentState = host.readState();
        expect(currentState.quits).toBe(0);
        expect(currentState.launches.length).toBe(0);
      }
    } finally {
      await host.close();
      mock.stop();
    }
  });

  test("4. 模型列表與 Usage 卡片在除錯埠未回應、主畫面不唯一、找不到連線物件（提示 Update）或驗證挑戰失敗時回傳可讀診斷且不洩漏內部混淆名或權杖", async () => {
    const mock = await startMockCdpServer({
      kind: "success",
      exportName: "obfuscatedClientExportX9",
    });
    const host = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: mock.port,
        cdpUrl: mock.cdpUrl,
      },
    });

    try {
      const auth = await host.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      await host.call("callback", { session: auth.session });

      const diagnosticCases = [
        {
          name: "cdp_unreachable",
          apply: () =>
            host.updateState({
              running: true,
              debuggingPort: 19,
              cdpUrl: "http://127.0.0.1:19",
            }),
          expectedKeyword: "Sign in",
        },
        {
          name: "renderer_not_unique",
          apply: () => {
            host.updateState({
              running: true,
              debuggingPort: mock.port,
              cdpUrl: mock.cdpUrl,
            });
            mock.setScenario({
              pageCount: 2,
              noModules: false,
              noClientExports: false,
              attestationFails: false,
            });
          },
          expectedKeyword: "主視窗",
        },
        {
          name: "client_not_found",
          apply: () => {
            mock.setScenario({
              pageCount: 1,
              noModules: false,
              noClientExports: true,
              attestationFails: false,
            });
          },
          expectedKeyword: "Update",
        },
        {
          name: "attestation_failed",
          apply: () => {
            mock.setScenario({
              pageCount: 1,
              noModules: false,
              noClientExports: false,
              attestationFails: true,
            });
          },
          expectedKeyword: "登入",
        },
      ];

      for (const tc of diagnosticCases) {
        tc.apply();
        const providersList = await host.call("providers");
        const p = providersList.find((item) => item.id === "chatgpt-desktop");
        const usageRes = await host.call("usage", {
          provider: "chatgpt-desktop",
        });

        expect(p.fellBack).toBe(true);
        expect(p.listError).toContain(tc.expectedKeyword);
        expect(usageRes.error).toContain(tc.expectedKeyword);

        for (const msg of [p.listError, usageRes.error]) {
          expect(msg).not.toContain("obfuscatedClientExportX9");
          expect(msg).not.toContain("fTt");
          expect(msg).not.toContain("notAClient");
          expect(msg).not.toContain("token_secret_xyz");
          expect(msg).not.toContain("secret-attestation-token-999");
        }
      }
    } finally {
      await host.close();
      mock.stop();
    }
  });

  test("5. 從桌面版內部目錄動態讀取模型並全數設定 tool_call: false、僅宣告文字輸入與文字輸出；離線時直接回報 listError 且無靜態保底模型", async () => {
    const mock = await startMockCdpServer({ kind: "success" });
    const host = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: mock.port,
        cdpUrl: mock.cdpUrl,
      },
    });

    try {
      const auth = await host.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      await host.call("callback", { session: auth.session });

      const onlineList = await host.call("providers");
      const onlineProvider = onlineList.find((p) => p.id === "chatgpt-desktop");
      expect(onlineProvider.fellBack).toBe(false);
      expect(onlineProvider.listError).toBe("");
      expect(onlineProvider.models.map((m) => m.id)).toEqual([
        THINKING_MODEL,
        PRO_MODEL,
        INSTANT_MODEL,
      ]);
      for (const m of onlineProvider.models) {
        expect(m.image).toBe(false);
        expect(m.inputs).toEqual(["text"]);
        expect(m.outputs).toEqual(["text"]);
      }

      const pluginInstance = await chatgptDesktopPlugin(
        {},
        { cdpUrl: mock.cdpUrl },
      );
      const rawModelsMap = await pluginInstance.provider.models(
        {},
        { auth: { access: mock.cdpUrl } },
      );
      for (const modelDef of Object.values(rawModelsMap)) {
        expect(modelDef.tool_call).toBe(false);
        expect(modelDef.capabilities.toolcall).toBe(false);
        expect(modelDef.modalities).toEqual({
          input: ["text"],
          output: ["text"],
        });
      }

      // 離線時直接回報 listError，models 清單為空（不維護靜態保底模型）
      host.updateState({
        running: false,
        debuggingPort: null,
        cdpUrl: null,
      });
      const offlineList = await host.call("providers");
      const offlineProvider = offlineList.find(
        (p) => p.id === "chatgpt-desktop",
      );
      expect(offlineProvider.fellBack).toBe(true);
      expect(offlineProvider.listError.length).toBeGreaterThan(0);
      expect(offlineProvider.models).toEqual([]);
    } finally {
      await host.close();
      mock.stop();
    }
  });

  test("6. 供應商設定頁宣告 instant_fallback 開關（default: false）；關閉時遇配額拒絕直接報錯，開啟時不論請求 Pro 或 Thinking 模型遇 model_cap_exceeded 皆自動改送同版本非工作模式 Instant 一次", async () => {
    const mock = await startMockCdpServer({ kind: "quota" });
    const host = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: mock.port,
        cdpUrl: mock.cdpUrl,
      },
    });

    try {
      const auth = await host.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      await host.call("callback", { session: auth.session });

      // (a) 預設關閉 (instant_fallback: false) 時，Thinking 與 Pro 遇 model_cap_exceeded 直接回傳 429，不重送 Instant
      for (const model of [THINKING_MODEL, PRO_MODEL]) {
        const res = await host.call("fetch", {
          provider: "chatgpt-desktop",
          model,
          url: "http://127.0.0.1/v1/chat/completions",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              model,
              messages: [{ role: "user", content: "quota test" }],
            }),
          ).toString("base64"),
        });
        expect(res.status).toBe(429);
        const errBody = JSON.parse(res.body);
        expect(errBody.error.code).toBe("model_cap_exceeded");
      }
      expect(mock.state.requests.map((r) => r.model)).toEqual([
        THINKING_MODEL,
        PRO_MODEL,
      ]);

      // (b) 開啟 instant_fallback: true 後，不論請求 Thinking 或 Pro 模型皆自動改送 gpt-5-6-instant 一次並成功
      mock.state.requests.length = 0;
      await host.call("setProviderOptions", {
        options: {
          "chatgpt-desktop": {
            instant_fallback: true,
          },
        },
      });

      for (const model of [THINKING_MODEL, PRO_MODEL]) {
        const res = await host.call("fetch", {
          provider: "chatgpt-desktop",
          model,
          url: "http://127.0.0.1/v1/chat/completions",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              model,
              messages: [{ role: "user", content: "quota fallback test" }],
            }),
          ).toString("base64"),
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.choices[0].message.content).toBe(DEFAULT_ANSWER);
        expect(body.model).toBe(INSTANT_MODEL);
      }

      expect(mock.state.requests.map((r) => r.model)).toEqual([
        THINKING_MODEL,
        INSTANT_MODEL,
        PRO_MODEL,
        INSTANT_MODEL,
      ]);
    } finally {
      await host.close();
      mock.stop();
    }
  });

  test("7. 轉發對話請求支援單次 JSON 與 SSE 串流格式，非文字輸入回傳 HTTP 400；已送出後若串流中斷或無完成訊息回傳 HTTP 502 與 X-Should-Retry: false 且只送出 1 次請求", async () => {
    const mock = await startMockCdpServer({
      kind: "success",
      answer: "Hello from host bridge",
    });
    const host = await startMagpieHost({
      stateData: {
        running: true,
        debuggingPort: mock.port,
        cdpUrl: mock.cdpUrl,
      },
    });

    try {
      const auth = await host.call("authorize", {
        provider: "chatgpt-desktop",
        method: 0,
        inputs: {},
      });
      await host.call("callback", { session: auth.session });

      // (a) 單次 JSON 回應 (stream: false)
      const jsonRes = await host.call("fetch", {
        provider: "chatgpt-desktop",
        model: THINKING_MODEL,
        url: "http://127.0.0.1/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            model: THINKING_MODEL,
            stream: false,
            messages: [{ role: "user", content: "Give me JSON" }],
          }),
        ).toString("base64"),
      });
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.headers["content-type"]).toContain("application/json");
      const parsedJson = JSON.parse(jsonRes.body);
      expect(parsedJson.object).toBe("chat.completion");
      expect(parsedJson.choices[0].message).toEqual({
        role: "assistant",
        content: "Hello from host bridge",
      });
      expect(parsedJson.choices[0].finish_reason).toBe("stop");

      // (b) SSE 串流回應 (stream: true)
      const sseRes = await host.call("fetch", {
        provider: "chatgpt-desktop",
        model: THINKING_MODEL,
        url: "http://127.0.0.1/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            model: THINKING_MODEL,
            stream: true,
            messages: [{ role: "user", content: "Give me SSE" }],
          }),
        ).toString("base64"),
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers["content-type"]).toContain("text/event-stream");
      expect(sseRes.body).toContain('"object":"chat.completion.chunk"');
      expect(sseRes.body).toContain("Hello from host bridge");
      expect(sseRes.body).toContain('"finish_reason":"stop"');
      expect(sseRes.body).toContain("data: [DONE]");

      // (c) 夾帶非文字輸入時回傳 HTTP 400，且不向桌面版送出任何對話請求
      mock.state.requests.length = 0;
      const badInputRes = await host.call("fetch", {
        provider: "chatgpt-desktop",
        model: THINKING_MODEL,
        url: "http://127.0.0.1/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            model: THINKING_MODEL,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: "https://example.com/img.png" },
                  },
                ],
              },
            ],
          }),
        ).toString("base64"),
      });
      expect(badInputRes.status).toBe(400);
      expect(mock.state.requests.length).toBe(0);

      // (d) 已送出後串流中斷 (premature) 與無完成訊息 (emptyConversation)：回傳 HTTP 502 + X-Should-Retry: false，且每次只向桌面版送出 1 次請求
      for (const unsafeScenario of [
        { kind: "premature", emptyConversation: false },
        { kind: "success", emptyConversation: true },
      ]) {
        mock.setScenario(unsafeScenario);
        mock.state.requests.length = 0;

        const unsafeRes = await host.call("fetch", {
          provider: "chatgpt-desktop",
          model: THINKING_MODEL,
          url: "http://127.0.0.1/v1/chat/completions",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Buffer.from(
            JSON.stringify({
              model: THINKING_MODEL,
              messages: [{ role: "user", content: "unsafe send state" }],
            }),
          ).toString("base64"),
        });

        expect(unsafeRes.status).toBe(502);
        expect(unsafeRes.headers["x-should-retry"]).toBe("false");
        expect(mock.state.requests.length).toBe(1);
      }

      expect(host.nonJsonStdoutLines).toEqual([]);
    } finally {
      await host.close();
      mock.stop();
    }
  });
});
