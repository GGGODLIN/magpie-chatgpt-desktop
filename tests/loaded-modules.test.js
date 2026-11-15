import "./no-real-app-env.js";
import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli.js";
import { listModels, sendConversation } from "../src/core.js";

const sharedUrl = "app://-/assets/app-shared-fixture.js";
const initialUrl = "app://-/assets/app-initial-fixture.js";
const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

const startRenderer = ({ failure, debuggerFails = false, hidden = true } = {}) => {
  const state = { methods: [], evaluations: 0 };
  const modules = new Map([
    [sharedUrl, dataModule("export const stub = {};\n//") + "#/assets/app-shared-fixture.js"],
    [initialUrl, dataModule(`
      export const renamedClient = {
        safeGet: async (path) => path === "/ios/attestation_challenge"
          ? { attestation_challenge: "synthetic-challenge" }
          : { models: [{ slug: "fixture-model", title: "Fixture model" }] },
        streamPost: (_path, options) => {
          options.onEvent({ data: {
            conversation_id: "fixture-conversation",
            message: {
              author: { role: "assistant" },
              status: "finished_successfully",
              content: { content_type: "text", parts: ["fixture answer"] },
              metadata: { model_slug: "fixture-model" },
            },
          } });
          options.onComplete();
        },
        cancelStream() {},
      };
    //`) + "#/assets/app-initial-fixture.js"],
  ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (new URL(req.url).pathname === "/json/list") {
        return Response.json([{
          type: "page",
          url: "app://-/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/renderer`,
        }]);
      }
      if (server.upgrade(req)) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      async message(ws, raw) {
        const command = JSON.parse(String(raw));
        state.methods.push(command.method);
        const reply = (result) => ws.send(JSON.stringify({ id: command.id, result }));
        if (command.method === "Debugger.enable") {
          if (debuggerFails) {
            ws.send(JSON.stringify({ id: command.id, error: { message: "Unavailable" } }));
            return;
          }
          for (const url of [sharedUrl, ...(hidden ? [initialUrl] : [])]) {
            ws.send(JSON.stringify({ method: "Debugger.scriptParsed", params: { url } }));
          }
          reply({});
          return;
        }
        if (command.method === "Debugger.disable") {
          reply({});
          return;
        }
        state.evaluations += 1;
        if (failure) {
          reply({ result: { value: failure } });
          return;
        }
        try {
          let expression = command.params.expression;
          for (const [url, moduleUrl] of modules) {
            expression = expression.replaceAll(url, moduleUrl);
          }
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const evaluate = new AsyncFunction("performance", "document", "fetch", `return await ${expression};`);
          const value = await evaluate(
            { getEntriesByType: () => [] },
            { querySelectorAll: () => [{ href: modules.get(sharedUrl) }] },
            async () => { throw new Error("Asset fetch unavailable"); },
          );
          reply({ result: { value } });
        } catch (error) {
          reply({ exceptionDetails: { text: String(error?.message ?? error) } });
        }
      },
    },
  });
  return {
    cdpUrl: `http://127.0.0.1:${server.port}`,
    state,
    stop: () => server.stop(true),
  };
};

describe("資源清單與入口讀取都找不到已載入的 client 模組", () => {
  test("CLI probe 能從已載入模組取得 client 並驗證 challenge", async () => {
    const renderer = startRenderer();
    let output = "";
    try {
      const code = await runCli(["--probe"], {
        cdpUrl: renderer.cdpUrl,
        env: {},
        writeStdout: (text) => { output += text; },
      });
      expect(code).toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        clientExport: "renamedClient",
        challengeOk: true,
      });
      expect(renderer.state.methods).toContain("Debugger.disable");
    } finally {
      renderer.stop();
    }
  });

  test("模型清單沿用同一個已認證 client", async () => {
    const renderer = startRenderer();
    try {
      const result = await listModels({ cdpUrl: renderer.cdpUrl, env: {} });
      expect(result.clientExport).toBe("renamedClient");
      expect(result.models).toContainEqual(expect.objectContaining({
        id: "fixture-model",
        name: "Fixture model",
        tool_call: false,
      }));
    } finally {
      renderer.stop();
    }
  });

  test("只在送出前解析失敗時補查模組，模擬對話仍回傳原答案", async () => {
    const renderer = startRenderer();
    try {
      const result = await sendConversation({
        cdpUrl: renderer.cdpUrl,
        env: {},
        model: "fixture-model",
        prompt: "synthetic prompt",
      });
      expect(result).toMatchObject({
        answer: "fixture answer",
        model: "fixture-model",
        conversationId: "fixture-conversation",
        clientExport: "renamedClient",
        fallbackUsed: false,
      });
    } finally {
      renderer.stop();
    }
  });

  for (const [name, options] of [
    ["Debugger 不可用", { debuggerFails: true }],
    ["已載入模組仍沒有 client", { hidden: false }],
  ]) {
    test(`${name}時保留原解析錯誤且不無限重試`, async () => {
      const renderer = startRenderer(options);
      let output = "";
      try {
        const code = await runCli(["--probe"], {
          cdpUrl: renderer.cdpUrl,
          env: {},
          writeStdout: (text) => { output += text; },
        });
        expect(code).toBe(1);
        expect(JSON.parse(output)).toEqual({ ok: false, error: "renderer 裡沒有已登入的 client" });
        expect(renderer.state.evaluations).toBeLessThanOrEqual(2);
      } finally {
        renderer.stop();
      }
    });
  }

  for (const failure of [
    { error: "attestation denied", stage: "attestation_failed", retrySafe: true },
    { error: "send uncertain", stage: "unknown_send_state", retrySafe: false },
    { error: "unsafe resolution", stage: "client_not_found", retrySafe: false },
  ]) {
    test(`保留 ${failure.error}，不重新執行對話`, async () => {
      const renderer = startRenderer({ failure });
      try {
        await expect(sendConversation({
          cdpUrl: renderer.cdpUrl,
          env: {},
          model: "fixture-model",
          prompt: "synthetic prompt",
        })).rejects.toMatchObject({
          message: failure.error,
          stage: failure.stage,
          retrySafe: failure.retrySafe,
        });
        expect(renderer.state.evaluations).toBe(1);
        expect(renderer.state.methods).toEqual(["Runtime.evaluate"]);
      } finally {
        renderer.stop();
      }
    });
  }

  test("26.1029 數字檔名 Rspack 入口經 __webpack_require__.c 解析 client 並救回 <| 殭屍串流", async () => {
    const rspackEntryUrl = "app://-/assets/348410.ae8bb87271.js";
    const rspackDataUrl = dataModule(`
      const rspackClient = {
        safeGet: async (path) => path === "/ios/attestation_challenge"
          ? { attestation_challenge: "rspack-challenge" }
          : { models: [{ slug: "gpt-6-thinking", title: "GPT-6" }] },
        streamPost: (_path, options) => {
          options.onEvent({ data: {
            conversation_id: "zombie-conv-1",
            message: {
              author: { role: "assistant" },
              channel: "final",
              status: "in_progress",
              create_time: 10,
              content: { content_type: "text", parts: ["<escape>{\\"tag\\":\\"none\\"}<|garbage"] },
              metadata: { model_slug: "gpt-6-thinking" },
            },
          } });
          options.onPrematureTermination();
        },
        cancelStream() {},
      };
      export const __webpack_require__ = {
        c: {
          sJS8: { id: "sJS8", exports: { $t: rspackClient } },
        },
      };
    //`) + "#/assets/348410.ae8bb87271.js";

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/json/list") {
          return Response.json([{
            type: "page",
            url: "app://-/index.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/renderer`,
          }]);
        }
        if (srv.upgrade(req)) return;
        return new Response("Not found", { status: 404 });
      },
      websocket: {
        async message(ws, raw) {
          const command = JSON.parse(String(raw));
          if (command.method === "Debugger.enable") {
            ws.send(JSON.stringify({ method: "Debugger.scriptParsed", params: { url: rspackEntryUrl } }));
            ws.send(JSON.stringify({ id: command.id, result: {} }));
            return;
          }
          if (command.method === "Debugger.disable") {
            ws.send(JSON.stringify({ id: command.id, result: {} }));
            return;
          }
          const expression = command.params.expression.replaceAll(rspackEntryUrl, rspackDataUrl);
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const evaluate = new AsyncFunction("performance", "document", "fetch", `return await ${expression};`);
          const value = await evaluate(
            { getEntriesByType: () => [] },
            { querySelectorAll: () => [{ src: rspackDataUrl }] },
            async () => { throw new Error("Asset fetch unavailable"); },
          );
          ws.send(JSON.stringify({ id: command.id, result: { result: { value } } }));
        },
      },
    });

    try {
      const cdpUrl = `http://127.0.0.1:${server.port}`;
      let probeOut = "";
      const code = await runCli(["--probe"], {
        cdpUrl,
        env: {},
        writeStdout: (t) => { probeOut += t; },
      });
      expect(code).toBe(0);
      expect(JSON.parse(probeOut)).toMatchObject({
        ok: true,
        clientExport: "sJS8.$t",
        challengeOk: true,
      });

      const chat = await sendConversation({
        cdpUrl,
        env: {},
        model: "gpt-6-thinking",
        effort: "standard",
        prompt: "synthetic prompt",
      });
      expect(chat).toMatchObject({
        answer: '{"tag":"none"}',
        model: "gpt-6-thinking",
        conversationId: "zombie-conv-1",
      });
    } finally {
      server.stop(true);
    }
  });
});
