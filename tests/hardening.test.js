import "./no-real-app-env.js";
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.js";
import {
  ChatGPTDesktopError,
  RENDERER_URL,
  buildChatExpression,
  buildResolverJs,
  evaluateInRenderer,
  formatMessagesToPrompt,
  getRendererTarget,
  redactSecrets,
  resetUnusualActivityCooldown,
  sendConversation,
} from "../src/core.js";
import chatgptDesktopPlugin from "../src/index.js";
import {
  checkDailyBudget,
  chatgptWebBizPlugin,
  rewriteConversationBody,
  sendWebConversation,
} from "../src/web.js";

const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
  resetUnusualActivityCooldown();
});

const makeTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe("core CDP state machine, listener cleanup, escaping, and secret redaction", () => {
  test("getRendererTarget and evaluateInRenderer honor pre-aborted signal without touching network or socket", async () => {
    const controller = new AbortController();
    controller.abort();

    let fetchCalled = 0;
    await expect(
      getRendererTarget({
        cdpUrl: "http://127.0.0.1:19333",
        signal: controller.signal,
        fetchImpl: async () => {
          fetchCalled += 1;
          return Response.json([]);
        },
      }),
    ).rejects.toMatchObject({
      stage: "aborted",
      retrySafe: true,
    });
    expect(fetchCalled).toBe(0);

    let wsConstructed = 0;
    class TrackingWs {
      constructor() {
        wsConstructed += 1;
      }
      close() {}
    }
    await expect(
      evaluateInRenderer({
        wsUrl: "ws://127.0.0.1:19333/page",
        expression: "({ ok: true })",
        signal: controller.signal,
        generation: true,
        WebSocketImpl: TrackingWs,
      }),
    ).rejects.toMatchObject({
      stage: "aborted",
      retrySafe: true,
    });
    expect(wsConstructed).toBe(0);
  });

  test("evaluateInRenderer detaches WS listeners on settle, decodes binary frames, and treats pre-open WS error as retrySafe cdp_unreachable", async () => {
    let createdWs = null;
    class BinaryMockWs {
      constructor() {
        this.handlers = new Map();
        this.closed = false;
        createdWs = this;
        queueMicrotask(() => {
          this.emit("open", {});
        });
      }
      addEventListener(event, fn) {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event).add(fn);
      }
      removeEventListener(event, fn) {
        this.handlers.get(event)?.delete(fn);
      }
      emit(event, payload) {
        for (const fn of [...(this.handlers.get(event) ?? [])]) fn(payload);
      }
      send() {
        const bytes = new TextEncoder().encode(
          JSON.stringify({ id: 1, result: { result: { value: { answer: "from-binary", ok: true } } } }),
        );
        queueMicrotask(() => {
          this.emit("message", { data: bytes });
        });
      }
      close() {
        this.closed = true;
      }
    }

    const res = await evaluateInRenderer({
      wsUrl: "ws://127.0.0.1:1/page",
      expression: "({ ok: true })",
      generation: true,
      WebSocketImpl: BinaryMockWs,
    });
    expect(res.answer).toBe("from-binary");
    expect(createdWs.closed).toBe(true);
    for (const set of createdWs.handlers.values()) {
      expect(set.size).toBe(0);
    }

    class FailingHandshakeWs {
      constructor() {
        this.handlers = new Map();
        queueMicrotask(() => {
          this.emit("error", { message: "connect ECONNREFUSED" });
        });
      }
      addEventListener(event, fn) {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event).add(fn);
      }
      removeEventListener(event, fn) {
        this.handlers.get(event)?.delete(fn);
      }
      emit(event, payload) {
        for (const fn of [...(this.handlers.get(event) ?? [])]) fn(payload);
      }
      close() {}
    }

    await expect(
      evaluateInRenderer({
        wsUrl: "ws://127.0.0.1:1/page",
        expression: "({ ok: true })",
        generation: true,
        WebSocketImpl: FailingHandshakeWs,
      }),
    ).rejects.toMatchObject({
      stage: "cdp_unreachable",
      retrySafe: true,
    });
  });

  test("buildResolverJs survives null-prototype safeGet, throwing export getters, and __proto__ Rspack keys", async () => {
    const resolverSrc = buildResolverJs(["preferredExport"]);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(
      "performance",
      "document",
      "__testMod",
      `
      ${resolverSrc}
      return await resolveChatGPTClient(__testMod, async (c) => await c.safeGet("/ios/attestation_challenge"));
      `,
    );

    const nullProto = Object.create(null);
    const mod = {};
    Object.defineProperty(mod, "brokenGetter", {
      enumerable: true,
      get() {
        throw new Error("TDZ access");
      },
    });
    mod.weirdObj = {
      safeGet: nullProto,
      streamPost: () => {},
      cancelStream: () => {},
    };
    mod.realClient = {
      safeGet: async () => ({ attestation_challenge: "ok-challenge" }),
      streamPost: () => {},
      cancelStream: () => {},
    };

    const resolved = await fn({ getEntriesByType: () => [] }, { querySelectorAll: () => [] }, mod);
    expect(resolved.exportName).toBe("realClient");
    expect(resolved.probeValue.attestation_challenge).toBe("ok-challenge");

    expect(resolverSrc).toContain("Object.create(null)");
  });

  test("buildChatExpression escapes Unicode line separators, parses stringified SSE event data, and handles dailyBudget 0 without NaN", async () => {
    const specialPrompt = "line1\u2028line2\u2029\"quotes\"'`${1+1}`\x00end";
    const expr = buildChatExpression({
      prompt: specialPrompt,
      model: "gpt-6-thinking",
      effort: "standard",
      dailyBudget: 0,
    });
    expect(expr).not.toContain("\u2028");
    expect(expr).not.toContain("\u2029");

    const modSrc = `
      export const Ymr = {
        safeGet: async (p) => p === "/ios/attestation_challenge"
          ? { attestation_challenge: "ch-1" }
          : { mapping: {} },
        streamPost: (_p, init) => {
          init.onEvent({
            type: "fetch-stream-event",
            data: JSON.stringify({
              conversation_id: "conv-str-sse",
              message: {
                author: { role: "assistant" },
                status: "finished_successfully",
                channel: "final",
                recipient: "all",
                content: { content_type: "text", parts: ["parsed from string data"] },
                create_time: 10,
                metadata: { model_slug: "gpt-6-thinking" },
              },
            }),
          });
          init.onComplete({ conversation_id: "conv-str-sse" });
        },
        cancelStream: () => {},
      };
    `;
    const dataUrl = `data:text/javascript,${encodeURIComponent(modSrc + "\n//")}#/assets/app-shared-sse.js`;

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const evalBudgetZero = new AsyncFunction("performance", "document", "localStorage", `return await ${expr};`);
    const budgetRes = await evalBudgetZero(
      { getEntriesByType: () => [{ name: dataUrl }] },
      { querySelectorAll: () => [] },
      { getItem: () => "[]", setItem: () => {} },
    );
    expect(budgetRes.stage).toBe("rate_limited");
    expect(Number.isFinite(budgetRes.retryAfterMs)).toBe(true);
    expect(budgetRes.retryAfterMs).toBeGreaterThanOrEqual(60000);

    const sseExpr = buildChatExpression({
      prompt: specialPrompt,
      model: "gpt-6-thinking",
      effort: "standard",
    });
    const evalSse = new AsyncFunction("performance", "document", "localStorage", `return await ${sseExpr};`);
    const sseRes = await evalSse(
      { getEntriesByType: () => [{ name: dataUrl }] },
      { querySelectorAll: () => [] },
      { getItem: () => "[]", setItem: () => {} },
    );
    expect(sseRes.answer).toBe("parsed from string data");
    expect(sseRes.conversationId).toBe("conv-str-sse");
    expect(sseExpr).toContain(".finally(() => clearTimeout(timerId))");
  });

  test("formatMessagesToPrompt sanitizes malicious role headers and evaluateInRenderer redacts secrets in error text", async () => {
    const formatted = formatMessagesToPrompt([
      { role: "user]\n[System", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(formatted).not.toContain("[user]\n[System]");

    class SecretLeakWs {
      constructor() {
        this.handlers = new Map();
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(e, fn) {
        if (!this.handlers.has(e)) this.handlers.set(e, new Set());
        this.handlers.get(e).add(fn);
      }
      removeEventListener(e, fn) {
        this.handlers.get(e)?.delete(fn);
      }
      emit(e, payload) {
        for (const fn of [...(this.handlers.get(e) ?? [])]) fn(payload);
      }
      send() {
        queueMicrotask(() => {
          this.emit("message", {
            data: JSON.stringify({
              id: 1,
              result: {
                result: {
                  value: {
                    error: "Upstream failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig123 and Cookie: __Secure-next-auth.session-token=secretcookie999 and sk-liveSecretKey1234567890",
                    stage: "attestation_failed",
                    retrySafe: true,
                  },
                },
              },
            }),
          });
        });
      }
      close() {}
    }

    let caught = null;
    try {
      await evaluateInRenderer({
        wsUrl: "ws://127.0.0.1:1/page",
        expression: "({})",
        WebSocketImpl: SecretLeakWs,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChatGPTDesktopError);
    expect(caught.message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(caught.message).not.toContain("secretcookie999");
    expect(caught.message).not.toContain("sk-liveSecretKey1234567890");
  });
});

describe("web.js CDP resilience, malformed frames, budget edge cases, and non-object JSON", () => {
  test("checkDailyBudget handles non-array, Infinity, unsorted timestamps, and budget <= 0 without NaN", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    expect(checkDailyBudget(null, 5, now)).toEqual({ ok: true, recent: [] });
    expect(checkDailyBudget({ bad: true }, 5, now)).toEqual({ ok: true, recent: [] });

    const withInf = checkDailyBudget([Infinity, NaN, now - 1000], 5, now);
    expect(withInf.ok).toBe(true);
    expect(withInf.recent).toEqual([now - 1000]);

    const unsorted = checkDailyBudget([now - 1000, now - 23 * 60 * 60 * 1000], 2, now);
    expect(unsorted.ok).toBe(false);
    expect(unsorted.retryAfterMs).toBe(60 * 60 * 1000);

    const zeroBudget = checkDailyBudget([], 0, now);
    expect(zeroBudget.ok).toBe(false);
    expect(Number.isFinite(zeroBudget.retryAfterMs)).toBe(true);
    expect(zeroBudget.retryAfterMs).toBeGreaterThanOrEqual(60000);
  });

  test("rewriteConversationBody survives null body or missing messages", () => {
    const out = rewriteConversationBody(null, { prompt: "hi", model: "gpt-6-thinking", effort: "high" });
    expect(out.model).toBe("gpt-6-thinking");
    expect(out.history_and_training_disabled).toBe(true);
    expect(out.is_do_not_remember).toBe(true);
    expect(out.thinking_effort).toBe("extended");
  });

  test("sendWebConversation rejects promptly when CDP WebSocket closes mid-command or sends malformed JSON", async () => {
    const dir = makeTempDir("web-hardening-");
    let mode = "close-mid-command";
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        const url = new URL(req.url);
        if (url.pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` });
        }
        if (s.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          if (mode === "close-mid-command") {
            ws.close();
            return;
          }
          if (mode === "malformed-frame") {
            ws.send("{truncated-json");
            ws.close();
            return;
          }
          if (cmd.method === "Target.getTargets") ws.send(JSON.stringify({ id: cmd.id, result: { targetInfos: [{ type: "page" }] } }));
          else if (cmd.method === "Target.createTarget") ws.send(JSON.stringify({ id: cmd.id, result: { targetId: "t1" } }));
          else if (cmd.method === "Target.attachToTarget") ws.send(JSON.stringify({ id: cmd.id, result: { sessionId: "s1" } }));
          else if (cmd.method === "Runtime.evaluate") {
            if (cmd.params.expression.includes("/api/auth/session") && !cmd.params.expression.includes("const token =")) {
              ws.send(JSON.stringify({ id: cmd.id, result: { result: { value: { user: { email: "biz@example.test" } } } } }));
            } else {
              ws.send(JSON.stringify({ id: cmd.id, result: { result: { value: { status: 200, body: "<html>cloudflare</html>" } } } }));
            }
          } else {
            ws.send(JSON.stringify({ id: cmd.id, result: {} }));
          }
        },
      },
    });
    cleanups.push(() => srv.stop(true));

    for (const nextMode of ["close-mid-command", "malformed-frame", "html-catalog"]) {
      mode = nextMode;
      const started = Date.now();
      await expect(
        sendWebConversation({
          cdpUrl: `http://127.0.0.1:${srv.port}`,
          expectedEmail: "biz@example.test",
          prompt: "hello",
          model: "gpt-6-thinking",
          timeoutMs: 3000,
          budgetFile: path.join(dir, "nested", "sends.json"),
        }),
      ).rejects.toBeInstanceOf(ChatGPTDesktopError);
      expect(Date.now() - started).toBeLessThan(2500);
    }
  });

  test("chatgptWebBizPlugin rejects non-object JSON body and top-level non-text attachments with 400", async () => {
    const biz = await chatgptWebBizPlugin({}, { cdpUrl: "http://127.0.0.1:19", expectedEmail: "biz@example.test" });
    const loader = await biz.auth.loader();

    for (const rawBody of ["null", "[]", "123", '"hello"']) {
      const res = await loader.fetch("http://127.0.0.1/v1/chat/completions", { body: rawBody });
      expect(res.status).toBe(400);
    }
    const attachRes = await loader.fetch("http://127.0.0.1/v1/chat/completions", {
      body: JSON.stringify({ model: "gpt-6-thinking", attachments: [{ id: "f1" }], messages: [{ role: "user", content: "hi" }] }),
    });
    expect(attachRes.status).toBe(400);
  });

  test("sendWebConversation handles malformed Fetch.requestPaused postData without unhandled rejections and still continues request", async () => {
    const dir = makeTempDir("web-paused-");
    let continuedIds = [];
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount += 1;
    };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => process.off("unhandledRejection", onUnhandled));

    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        const url = new URL(req.url);
        if (url.pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` });
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          let result = {};
          if (cmd.method === "Target.getTargets") result = { targetInfos: [{ type: "page" }] };
          if (cmd.method === "Target.createTarget") result = { targetId: "t1" };
          if (cmd.method === "Target.attachToTarget") result = { sessionId: "s1" };
          if (cmd.method === "Fetch.continueRequest") {
            continuedIds.push(cmd.params.requestId);
            if (cmd.params.requestId === "bad-post") {
              ws.send(JSON.stringify({
                method: "Network.responseReceived",
                sessionId: "s1",
                params: { response: { url: "https://chatgpt.com/backend-api/f/conversation", status: 400 } },
              }));
            }
          }
          if (cmd.method === "Runtime.evaluate") {
            const expr = cmd.params.expression;
            let value = true;
            if (expr.includes("const token =")) {
              value = { status: 200, body: JSON.stringify({ models: [{ slug: "gpt-6-thinking" }] }) };
            } else if (expr.includes("/api/auth/session")) {
              value = { user: { email: "biz@example.test" } };
            } else if (expr.includes("button.click()")) {
              ws.send(JSON.stringify({
                method: "Fetch.requestPaused",
                sessionId: "s1",
                params: {
                  requestId: "bad-post",
                  request: { url: "https://chatgpt.com/backend-api/f/conversation", postData: "{malformed-json" },
                },
              }));
            }
            result = { result: { value } };
          }
          ws.send(JSON.stringify({ id: cmd.id, result }));
        },
      },
    });
    cleanups.push(() => srv.stop(true));

    await expect(
      sendWebConversation({
        cdpUrl: `http://127.0.0.1:${srv.port}`,
        expectedEmail: "biz@example.test",
        prompt: "hi",
        model: "gpt-6-thinking",
        timeoutMs: 3000,
        budgetFile: path.join(dir, "sends.json"),
      }),
    ).rejects.toMatchObject({ stage: "send_rejected" });

    expect(continuedIds).toContain("bad-post");
    expect(unhandledCount).toBe(0);
  });

  test("chatgptWebBizPlugin enforces maxConcurrency 1 across concurrent requests", async () => {
    const dir = makeTempDir("web-serial-");
    let activeTabs = 0;
    let maxActiveTabs = 0;
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        if (new URL(req.url).pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` });
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        async message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          let result = {};
          if (cmd.method === "Target.getTargets") result = { targetInfos: [{ type: "page" }] };
          if (cmd.method === "Target.createTarget") {
            activeTabs += 1;
            maxActiveTabs = Math.max(maxActiveTabs, activeTabs);
            result = { targetId: `tab-${Math.random()}` };
          }
          if (cmd.method === "Target.closeTarget") {
            activeTabs -= 1;
          }
          if (cmd.method === "Target.attachToTarget") result = { sessionId: "s1" };
          if (cmd.method === "Runtime.evaluate") {
            const expr = cmd.params.expression;
            let value = true;
            if (expr.includes("const token =")) {
              if (expr.includes("/models?")) value = { status: 200, body: JSON.stringify({ models: [{ slug: "gpt-6-thinking" }] }) };
              else if (expr.includes("/stream_status")) value = { status: 200, body: JSON.stringify({ status: "COMPLETE" }) };
              else value = { status: 200, body: JSON.stringify({ mapping: { m: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["ok"] }, status: "finished_successfully", metadata: { model_slug: "gpt-6-thinking" } } } } }) };
            } else if (expr.includes("/api/auth/session")) {
              value = { user: { email: "biz@example.test" } };
            } else if (expr.includes("button.click()")) {
              ws.send(JSON.stringify({ method: "Fetch.requestPaused", sessionId: "s1", params: { requestId: "r1", request: { url: "https://chatgpt.com/backend-api/f/conversation", postData: JSON.stringify({ messages: [{ content: { parts: ["."] } }] }) } } }));
            }
            result = { result: { value } };
          }
          if (cmd.method === "Fetch.continueRequest" && cmd.params.postData) {
            ws.send(JSON.stringify({ method: "Network.requestWillBeSent", sessionId: "s1", params: { request: { url: "https://chatgpt.com/backend-api/conversation/11111111-1111-1111-1111-111111111111" } } }));
          }
          ws.send(JSON.stringify({ id: cmd.id, result }));
        },
      },
    });
    cleanups.push(() => srv.stop(true));

    const biz = await chatgptWebBizPlugin({}, {
      cdpUrl: `http://127.0.0.1:${srv.port}`,
      expectedEmail: "biz@example.test",
      budgetFile: path.join(dir, "sends.json"),
    });
    const loader = await biz.auth.loader();
    const [r1, r2] = await Promise.all([
      loader.fetch("http://127.0.0.1/v1/chat/completions", { body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "1" }] }) }),
      loader.fetch("http://127.0.0.1/v1/chat/completions", { body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "2" }] }) }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(maxActiveTabs).toBe(1);
  });
});

describe("index.js concurrency lock, abort queue cleanup, company fallback on closed Desktop, and JSON validation", () => {
  test("loader.fetch rejects non-object JSON bodies with HTTP 400 instead of 503", async () => {
    const dir = makeTempDir("idx-json-");
    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ running: false }));
    const inst = await chatgptDesktopPlugin({}, { stateFile });
    const loader = await inst.auth.loader(() => null);

    for (const rawBody of ["null", "[]", "42", '"str"']) {
      const res = await loader.fetch("http://127.0.0.1/v1/chat/completions", { body: rawBody });
      expect(res.status).toBe(400);
      const parsed = await res.json();
      expect(parsed.error.type).toBe("invalid_request_error");
    }
  });

  test("loader.fetch enforces maxConcurrency 1, drops aborted queued requests cleanly, and recovers after failure", async () => {
    const dir = makeTempDir("idx-queue-");
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        if (new URL(req.url).pathname === "/json/list") {
          return Response.json([{ type: "page", url: RENDERER_URL, webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` }]);
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        async message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          active += 1;
          maxActive = Math.max(maxActive, active);
          calls += 1;
          const idx = calls;
          await new Promise((r) => setTimeout(r, 70));
          active -= 1;
          if (idx === 1) {
            ws.send(JSON.stringify({ id: cmd.id, result: { result: { value: { error: "boom", stage: "unknown_send_state", retrySafe: false } } } }));
          } else {
            ws.send(JSON.stringify({ id: cmd.id, result: { result: { value: { answer: `reply-${idx}`, model: "gpt-6-thinking", conversationId: `c-${idx}`, outcome: "complete" } } } }));
          }
        },
      },
    });
    cleanups.push(() => srv.stop(true));

    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ running: true, cdpUrl: `http://127.0.0.1:${srv.port}` }));
    const inst = await chatgptDesktopPlugin({}, { stateFile });
    const loader = await inst.auth.loader(() => null);

    const abortCtrl = new AbortController();
    const p1 = loader.fetch("http://127.0.0.1/v1/chat/completions", {
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "req1" }] }),
    });
    const p2 = loader.fetch("http://127.0.0.1/v1/chat/completions", {
      signal: abortCtrl.signal,
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "req2-aborted" }] }),
    });
    const p3 = loader.fetch("http://127.0.0.1/v1/chat/completions", {
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "req3" }] }),
    });

    setTimeout(() => abortCtrl.abort(), 15);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(maxActive).toBe(1);
    expect(calls).toBe(2);
    expect(r1.status).toBe(502);
    expect(r2.status).not.toBe(200);
    expect(r3.status).toBe(200);
    expect((await r3.json()).choices[0].message.content).toBe("reply-2");
  });

  test("company_fallback still switches to company account when Desktop is stopped (resolveActiveCdpUrl unreachable)", async () => {
    const dir = makeTempDir("idx-closed-desktop-");
    const companySrv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        const url = new URL(req.url);
        if (url.pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/company` });
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          let result = {};
          if (cmd.method === "Target.getTargets") result = { targetInfos: [{ type: "page" }] };
          if (cmd.method === "Target.createTarget") result = { targetId: "tab1" };
          if (cmd.method === "Target.attachToTarget") result = { sessionId: "sess1" };
          if (cmd.method === "Runtime.evaluate") {
            const expr = cmd.params.expression;
            let value = true;
            if (expr.includes("const token =")) {
              if (expr.includes("/models?")) value = { status: 200, body: JSON.stringify({ models: [{ slug: "gpt-6-thinking" }] }) };
              else if (expr.includes("/stream_status")) value = { status: 200, body: JSON.stringify({ status: "COMPLETE" }) };
              else value = { status: 200, body: JSON.stringify({ mapping: { m: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["company rescued"] }, status: "finished_successfully", metadata: { model_slug: "gpt-6-thinking" } } } } }) };
            } else if (expr.includes("/api/auth/session")) {
              value = { user: { email: "backup@example.test" } };
            } else if (expr.includes("button.click()")) {
              ws.send(JSON.stringify({ method: "Fetch.requestPaused", sessionId: "sess1", params: { requestId: "r1", request: { url: "https://chatgpt.com/backend-api/f/conversation", postData: JSON.stringify({ messages: [{ content: { parts: ["."] } }] }) } } }));
            }
            result = { result: { value } };
          }
          if (cmd.method === "Fetch.continueRequest" && cmd.params.postData) {
            ws.send(JSON.stringify({ method: "Network.requestWillBeSent", sessionId: "sess1", params: { request: { url: "https://chatgpt.com/backend-api/conversation/11111111-1111-1111-1111-111111111111" } } }));
          }
          ws.send(JSON.stringify({ id: cmd.id, result }));
        },
      },
    });
    cleanups.push(() => companySrv.stop(true));

    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ running: false, debuggingPort: null, cdpUrl: null }));
    const inst = await chatgptDesktopPlugin(
      { magpie: { option: (_id, key) => key === "company_fallback" } },
      {
        stateFile,
        companyBackup: {
          cdpUrl: `http://127.0.0.1:${companySrv.port}`,
          expectedEmail: "backup@example.test",
          budgetFile: path.join(dir, "sends.json"),
        },
      },
    );
    const loader = await inst.auth.loader(() => null);
    const res = await loader.fetch("http://127.0.0.1/v1/chat/completions", {
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "help" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-ChatGPT-Account-Source")).toBe("company");
    expect((await res.json()).choices[0].message.content).toBe("company rescued");
  });

  test("authorize callback handles corrupted stateFile gracefully instead of throwing", async () => {
    const dir = makeTempDir("idx-corrupt-state-");
    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(stateFile, "{not-valid-json");
    const inst = await chatgptDesktopPlugin({}, { stateFile });
    const auth = await inst.auth.methods[0].authorize({});
    const result = await auth.callback();
    expect(result.type).toBe("failed");
    expect(typeof result.error).toBe("string");
  });

  test("loader.fetch releases serial lock after in-flight abort so subsequent requests do not stall", async () => {
    const dir = makeTempDir("idx-inflight-abort-");
    let evalNum = 0;
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        if (new URL(req.url).pathname === "/json/list") {
          return Response.json([{ type: "page", url: RENDERER_URL, webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` }]);
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          evalNum += 1;
          if (evalNum === 1) {
            return;
          }
          ws.send(JSON.stringify({
            id: cmd.id,
            result: { result: { value: { answer: "after-abort-ok", model: "gpt-6-thinking", conversationId: "c-next", outcome: "complete" } } },
          }));
        },
      },
    });
    cleanups.push(() => srv.stop(true));

    const stateFile = path.join(dir, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ running: true, cdpUrl: `http://127.0.0.1:${srv.port}` }));
    const inst = await chatgptDesktopPlugin({}, { stateFile });
    const loader = await inst.auth.loader(() => null);

    const ctrl = new AbortController();
    const first = loader.fetch("http://127.0.0.1/v1/chat/completions", {
      signal: ctrl.signal,
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "hang" }] }),
    });
    const second = loader.fetch("http://127.0.0.1/v1/chat/completions", {
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "next" }] }),
    });

    setTimeout(() => ctrl.abort(), 40);

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(502);
    expect(r2.status).toBe(200);
    expect((await r2.json()).choices[0].message.content).toBe("after-abort-ok");
  });
});

describe("cli.js flag validation, stdin error handling, and options JSON boundary", () => {
  test("rejects non-object --render-expression chat JSON, unknown flags, conflicting flags, and supports --help", async () => {
    for (const badJson of ["null", "[]", "123", '"abc"']) {
      let err = "";
      const code = await runCli(["--render-expression", "chat", badJson], {
        writeStdout: () => {},
        writeStderr: (s) => { err += s; },
      });
      expect(code).toBe(1);
      expect(err).toContain("無效的 options JSON");
    }

    let helpOut = "";
    const helpCode = await runCli(["--help"], {
      writeStdout: (s) => { helpOut += s; },
      writeStderr: () => {},
    });
    expect(helpCode).toBe(0);
    expect(helpOut.length).toBeGreaterThan(0);

    let unknownErr = "";
    const unknownCode = await runCli(["--bogus-flag"], {
      stdinText: "hi",
      writeStdout: () => {},
      writeStderr: (s) => { unknownErr += s; },
    });
    expect(unknownCode).toBe(1);
    expect(unknownErr).toContain("--bogus-flag");

    let conflictErr = "";
    const conflictCode = await runCli(["--instant-fallback", "--no-instant-fallback", "gpt-6-thinking"], {
      stdinText: "hi",
      writeStdout: () => {},
      writeStderr: (s) => { conflictErr += s; },
    });
    expect(conflictCode).toBe(1);
    expect(conflictErr.length).toBeGreaterThan(0);
  });

  test("returns exit code 1 cleanly when stdin stream errors, rejects oversized stdin, and redacts secrets in probe errors", async () => {
    const brokenStream = {
      async *[Symbol.asyncIterator]() {
        throw new Error("EIO stdin read failed");
      },
    };
    let err = "";
    const code = await runCli(["gpt-6-thinking"], {
      stdin: brokenStream,
      writeStdout: () => {},
      writeStderr: (s) => { err += s; },
    });
    expect(code).toBe(1);
    expect(err).toContain("stdin");

    const hugeStream = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(1024 * 1024, "a");
        yield Buffer.alloc(1024 * 1024, "a");
        yield Buffer.alloc(1024 * 1024, "a");
      },
    };
    let hugeErr = "";
    const hugeCode = await runCli(["gpt-6-thinking"], {
      stdin: hugeStream,
      writeStdout: () => {},
      writeStderr: (s) => { hugeErr += s; },
    });
    expect(hugeCode).toBe(1);
    expect(hugeErr).toContain("超過讀取上限");

    let probeOut = "";
    const probeCode = await runCli(["--probe"], {
      cdpUrl: "http://127.0.0.1:19333",
      fetchImpl: async () =>
        Response.json([{ type: "page", url: RENDERER_URL, webSocketDebuggerUrl: "ws://127.0.0.1:1/p" }]),
      WebSocketImpl: class {
        constructor() {
          throw new Error("auth failed Bearer secretTokenValue999");
        }
      },
      writeStdout: (s) => { probeOut += s; },
      writeStderr: () => {},
    });
    expect(probeCode).toBe(1);
    expect(probeOut).not.toContain("secretTokenValue999");
    expect(probeOut).toContain("[REDACTED]");

    let emptyJsonErr = "";
    const emptyJsonCode = await runCli(["--render-expression", "chat", ""], {
      writeStdout: () => {},
      writeStderr: (s) => { emptyJsonErr += s; },
    });
    expect(emptyJsonCode).toBe(1);
    expect(emptyJsonErr).toContain("無效的 options JSON");
  });
});

describe("deep edge-case hardening regressions", () => {
  test("evaluateInRenderer keeps retrySafe true when ws.send throws synchronously or WS drops during Debugger.enable discovery, and decodes direct Uint8Array payloads", async () => {
    class ThrowOnSendWs {
      constructor() {
        this.handlers = new Map();
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(e, fn) {
        if (!this.handlers.has(e)) this.handlers.set(e, new Set());
        this.handlers.get(e).add(fn);
      }
      removeEventListener(e, fn) {
        this.handlers.get(e)?.delete(fn);
      }
      emit(e, payload) {
        for (const fn of [...(this.handlers.get(e) ?? [])]) fn(payload);
      }
      send() {
        throw new Error("socket not ready");
      }
      close() {}
    }
    await expect(
      evaluateInRenderer({
        wsUrl: "ws://127.0.0.1:1/p",
        expression: "({})",
        generation: true,
        WebSocketImpl: ThrowOnSendWs,
      }),
    ).rejects.toMatchObject({
      stage: "cdp_unreachable",
      retrySafe: true,
    });

    class CloseDuringDiscoveryWs {
      constructor() {
        this.handlers = new Map();
        queueMicrotask(() => this.emit("open", {}));
      }
      addEventListener(e, fn) {
        if (!this.handlers.has(e)) this.handlers.set(e, new Set());
        this.handlers.get(e).add(fn);
      }
      removeEventListener(e, fn) {
        this.handlers.get(e)?.delete(fn);
      }
      emit(e, payload) {
        for (const fn of [...(this.handlers.get(e) ?? [])]) fn(payload);
      }
      send(raw) {
        const cmd = JSON.parse(raw);
        if (cmd.id === 1) {
          queueMicrotask(() =>
            this.emit("message", {
              data: JSON.stringify({
                id: 1,
                result: {
                  result: {
                    value: { error: "missing", stage: "module_not_found", retrySafe: true },
                  },
                },
              }),
            }),
          );
        } else if (cmd.id === 2) {
          queueMicrotask(() => this.emit("close", {}));
        }
      }
      close() {}
    }
    await expect(
      evaluateInRenderer({
        wsUrl: "ws://127.0.0.1:1/p",
        expression: "({})",
        generation: true,
        WebSocketImpl: CloseDuringDiscoveryWs,
      }),
    ).rejects.toMatchObject({
      stage: "cdp_unreachable",
      retrySafe: true,
    });

    class DirectUint8Ws {
      constructor() {
        this.handlers = new Map();
        queueMicrotask(() => this.emit("open", {}));
      }
      on(e, fn) {
        if (!this.handlers.has(e)) this.handlers.set(e, new Set());
        this.handlers.get(e).add(fn);
      }
      off(e, fn) {
        this.handlers.get(e)?.delete(fn);
      }
      emit(e, payload) {
        for (const fn of [...(this.handlers.get(e) ?? [])]) fn(payload);
      }
      send() {
        const bytes = new TextEncoder().encode(
          JSON.stringify({ id: 1, result: { result: { value: { answer: "direct-u8", ok: true } } } }),
        );
        queueMicrotask(() => this.emit("message", bytes));
      }
      close() {}
    }
    const res = await evaluateInRenderer({
      wsUrl: "ws://127.0.0.1:1/p",
      expression: "({})",
      generation: true,
      WebSocketImpl: DirectUint8Ws,
    });
    expect(res.answer).toBe("direct-u8");
  });

  test("buildChatExpression parses data:-prefixed and multi-line SSE frames, ignores NaN cooldown, and buildResolverJs falls back when primary chunk import throws", async () => {
    const modSrc = `
      export const Ymr = {
        safeGet: async (p) => p === "/ios/attestation_challenge"
          ? { attestation_challenge: "ch-sse" }
          : { mapping: {} },
        streamPost: (_p, init) => {
          init.onEvent("event: delta\\ndata: " + JSON.stringify({
            conversation_id: "conv-sse-multiline",
            message: {
              author: { role: "assistant" },
              status: "finished_successfully",
              channel: "final",
              recipient: "all",
              content: { content_type: "text", parts: ["multiline-sse-ok"] },
              create_time: 10,
              metadata: { model_slug: "gpt-6-thinking" },
            },
          }));
          init.onComplete({});
        },
        cancelStream: () => {},
      };
    `;
    const dataUrl = `data:text/javascript,${encodeURIComponent(modSrc + "\n//")}#/assets/app-shared-multiline.js`;
    const prevCooldown = globalThis.__magpieUnusualActivityUntil;
    globalThis.__magpieUnusualActivityUntil = NaN;
    try {
      const expr = buildChatExpression({ prompt: "hi", model: "gpt-6-thinking", effort: "standard" });
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const res = await new AsyncFunction("performance", "document", "localStorage", `return await ${expr};`)(
        { getEntriesByType: () => [{ name: dataUrl }] },
        { querySelectorAll: () => [] },
        { getItem: () => "[]", setItem: () => {} },
      );
      expect(res.answer).toBe("multiline-sse-ok");
      expect(res.conversationId).toBe("conv-sse-multiline");
    } finally {
      globalThis.__magpieUnusualActivityUntil = prevCooldown;
    }

    const goodMod = `export const Ymr = { safeGet: async () => ({ attestation_challenge: "ch-fallback" }), streamPost: () => {}, cancelStream: () => {} };`;
    const goodUrl = `data:text/javascript,${encodeURIComponent(goodMod + "\n//")}#/assets/app-initial-good.js`;
    const badUrl = `data:text/javascript,${encodeURIComponent('throw new Error("broken chunk");\n//')}#/assets/app-shared-broken.js`;
    const resolver = buildResolverJs(["Ymr"]);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const resolved = await new AsyncFunction("performance", "document", `${resolver}; return await attestedClient();`)(
      { getEntriesByType: () => [{ name: badUrl }, { name: goodUrl }] },
      { querySelectorAll: () => [] },
    );
    expect(resolved.exportName).toBe("Ymr");
    expect(resolved.probeValue.attestation_challenge).toBe("ch-fallback");
  });

  test("sendWebConversation aborts promptly during post-handshake hanging CDP command and fails before typing when Fetch.enable errors", async () => {
    const dir = makeTempDir("web-abort-fetch-");
    let closedTargets = [];
    const hangSrv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        if (new URL(req.url).pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` });
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          if (cmd.method === "Target.getTargets") {
            ws.send(JSON.stringify({ id: cmd.id, result: { targetInfos: [{ type: "page" }] } }));
          } else if (cmd.method === "Target.createTarget") {
            ws.send(JSON.stringify({ id: cmd.id, result: { targetId: "tab-abort" } }));
          } else if (cmd.method === "Target.closeTarget") {
            closedTargets.push(cmd.params.targetId);
            ws.send(JSON.stringify({ id: cmd.id, result: { success: true } }));
          }
        },
      },
    });
    cleanups.push(() => hangSrv.stop(true));

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const t0 = Date.now();
    await expect(
      sendWebConversation({
        cdpUrl: `http://127.0.0.1:${hangSrv.port}`,
        expectedEmail: "biz@example.test",
        prompt: "hi",
        model: "gpt-6-thinking",
        signal: ctrl.signal,
        budgetFile: path.join(dir, "sends.json"),
      }),
    ).rejects.toMatchObject({ stage: "aborted" });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(closedTargets).toContain("tab-abort");

    let insertedText = false;
    const fetchErrSrv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        if (new URL(req.url).pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` });
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          if (cmd.method === "Input.insertText") insertedText = true;
          if (cmd.method === "Target.getTargets") {
            ws.send(JSON.stringify({ id: cmd.id, result: { targetInfos: [{ type: "page" }] } }));
          } else if (cmd.method === "Target.createTarget") {
            ws.send(JSON.stringify({ id: cmd.id, result: { targetId: "t-err" } }));
          } else if (cmd.method === "Target.attachToTarget") {
            ws.send(JSON.stringify({ id: cmd.id, result: { sessionId: "s-err" } }));
          } else if (cmd.method === "Fetch.enable") {
            ws.send(JSON.stringify({ id: cmd.id, error: { code: -32601, message: "Fetch not available" } }));
          } else {
            ws.send(JSON.stringify({ id: cmd.id, result: {} }));
          }
        },
      },
    });
    cleanups.push(() => fetchErrSrv.stop(true));

    await expect(
      sendWebConversation({
        cdpUrl: `http://127.0.0.1:${fetchErrSrv.port}`,
        expectedEmail: "biz@example.test",
        prompt: "hi",
        model: "gpt-6-thinking",
        budgetFile: path.join(dir, "sends2.json"),
      }),
    ).rejects.toMatchObject({ stage: "cdp_unreachable" });
    expect(insertedText).toBe(false);
  });

  test("index.js and web.js decode Uint8Array JSON bodies, guard NaN rate_limited diagnostics, and fall back to company when stateFile is null or corrupted", async () => {
    const dir = makeTempDir("idx-deep-");
    const companySrv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        if (new URL(req.url).pathname === "/json/version") {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/company` });
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          let result = {};
          if (cmd.method === "Target.getTargets") result = { targetInfos: [{ type: "page" }] };
          if (cmd.method === "Target.createTarget") result = { targetId: "t1" };
          if (cmd.method === "Target.attachToTarget") result = { sessionId: "s1" };
          if (cmd.method === "Runtime.evaluate") {
            const expr = cmd.params.expression;
            let value = true;
            if (expr.includes("const token =")) {
              if (expr.includes("/models?")) value = { status: 200, body: JSON.stringify({ models: [{ slug: "gpt-6-thinking" }] }) };
              else if (expr.includes("/stream_status")) value = { status: 200, body: JSON.stringify({ status: "COMPLETE" }) };
              else value = { status: 200, body: JSON.stringify({ mapping: { m: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["uint8-company-ok"] }, status: "finished_successfully", metadata: { model_slug: "gpt-6-thinking" } } } } }) };
            } else if (expr.includes("/api/auth/session")) {
              value = { user: { email: "backup@example.test" } };
            } else if (expr.includes("button.click()")) {
              ws.send(JSON.stringify({ method: "Fetch.requestPaused", sessionId: "s1", params: { requestId: "r1", request: { url: "https://chatgpt.com/backend-api/f/conversation", postData: JSON.stringify({ messages: [{ content: { parts: ["."] } }] }) } } }));
            }
            result = { result: { value } };
          }
          if (cmd.method === "Fetch.continueRequest" && cmd.params.postData) {
            ws.send(JSON.stringify({ method: "Network.requestWillBeSent", sessionId: "s1", params: { request: { url: "https://chatgpt.com/backend-api/conversation/22222222-2222-2222-2222-222222222222" } } }));
          }
          ws.send(JSON.stringify({ id: cmd.id, result }));
        },
      },
    });
    cleanups.push(() => companySrv.stop(true));

    const stateFile = path.join(dir, "null-state.json");
    fs.writeFileSync(stateFile, "null");
    const inst = await chatgptDesktopPlugin(
      { magpie: { option: (_id, key) => key === "company_fallback" } },
      {
        stateFile,
        companyBackup: {
          cdpUrl: `http://127.0.0.1:${companySrv.port}`,
          expectedEmail: "backup@example.test",
          budgetFile: path.join(dir, "sends.json"),
        },
      },
    );
    const loader = await inst.auth.loader(() => null);
    const u8Body = new TextEncoder().encode(
      JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "hello" }] }),
    );
    const res = await loader.fetch("http://127.0.0.1/v1/chat/completions", { body: u8Body });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-ChatGPT-Account-Source")).toBe("company");
    expect((await res.json()).choices[0].message.content).toBe("uint8-company-ok");

    const nanSrv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, s) {
        if (new URL(req.url).pathname === "/json/list") {
          return Response.json([{ type: "page", url: RENDERER_URL, webSocketDebuggerUrl: `ws://127.0.0.1:${s.port}/ws` }]);
        }
        if (s.upgrade(req)) return;
        return new Response("404", { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const cmd = JSON.parse(String(raw));
          ws.send(JSON.stringify({
            id: cmd.id,
            result: { result: { value: { error: "limited", stage: "rate_limited", retrySafe: true, retryAfterMs: "bad" } } },
          }));
        },
      },
    });
    cleanups.push(() => nanSrv.stop(true));

    const state2 = path.join(dir, "ok-state.json");
    fs.writeFileSync(state2, JSON.stringify({ running: true, cdpUrl: `http://127.0.0.1:${nanSrv.port}` }));
    const inst2 = await chatgptDesktopPlugin({}, { stateFile: state2 });
    const loader2 = await inst2.auth.loader(() => null);
    const res429 = await loader2.fetch("http://127.0.0.1/v1/chat/completions", {
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res429.status).toBe(429);
    const body429 = await res429.json();
    expect(body429.error.message).not.toContain("NaN");
    expect(res429.headers.get("Retry-After")).not.toBe("NaN");
  });

  test("redactSecrets redacts all semicolon-separated cookies, joined Set-Cookie headers, and JSON cookie/auth values without eating next lines", () => {
    const multiCookie = redactSecrets(
      "Cookie: theme=dark; custom_session=superSecretCookieValue999; foo=bar\nNext line",
    );
    expect(multiCookie).toBe("Cookie: [REDACTED]\nNext line");
    expect(multiCookie).not.toContain("superSecretCookieValue999");
    expect(multiCookie).not.toContain("foo=bar");

    const multiHeader = redactSecrets(
      "Authorization: Bearer topSecretBearer123\r\nCookie: a=1; session=secretCookie2\r\nSet-Cookie: theme=dark; Path=/, sid=secretSetCookie3; HttpOnly\r\nX-Safe: visible",
    );
    expect(multiHeader).toBe(
      "Authorization: [REDACTED]\r\nCookie: [REDACTED]\r\nSet-Cookie: [REDACTED]\r\nX-Safe: visible",
    );
    expect(multiHeader).not.toContain("topSecretBearer123");
    expect(multiHeader).not.toContain("secretCookie2");
    expect(multiHeader).not.toContain("secretSetCookie3");

    expect(redactSecrets("Cookie:\nKeep this line")).toBe("Cookie:\nKeep this line");
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz\nSafe line")).toBe(
      "Authorization: [REDACTED]\nSafe line",
    );

    const jsonSecrets = redactSecrets(
      '{"cookie":"theme=dark; custom_session=jsonSecret999","authorization":"Basic dXNlcjpwYXNz","set-cookie":"a=\\"1\\"; sid=jsonSetCookie","ok":true}',
    );
    expect(jsonSecrets).toBe(
      '{"cookie":"[REDACTED]","authorization":"[REDACTED]","set-cookie":"[REDACTED]","ok":true}',
    );
  });

  test("redactSecrets redacts JSON set-cookie/cookie/auth arrays, URL userinfo credentials, and X-Api-Key headers without ReDoS", () => {
    const jsonArray = redactSecrets(
      '{"set-cookie":["theme=dark; Path=/","custom_session=secretArrayCookie999; HttpOnly","a=\\"1\\"; sid=escSecret"],"cookie":["k1=v1","k2=secretCookieArr"],"authorization":["Bearer tok1","Basic dXNlcjpwYXNz"],"ok":true}',
    );
    expect(jsonArray).toBe(
      '{"set-cookie":["[REDACTED]"],"cookie":["[REDACTED]"],"authorization":["[REDACTED]"],"ok":true}',
    );
    expect(jsonArray).not.toContain("secretArrayCookie999");
    expect(jsonArray).not.toContain("escSecret");
    expect(jsonArray).not.toContain("secretCookieArr");

    const urlCreds = redactSecrets(
      "connect failed ws://admin:wsSecret456@127.0.0.1:19333/devtools and https://alice:httpSecret789@proxy.test/v1\nX-Api-Key: customKeySecret000\nSafe",
    );
    expect(urlCreds).toBe(
      "connect failed ws://[REDACTED]@127.0.0.1:19333/devtools and https://[REDACTED]@proxy.test/v1\nX-Api-Key: [REDACTED]\nSafe",
    );
    expect(urlCreds).not.toContain("wsSecret456");
    expect(urlCreds).not.toContain("httpSecret789");
    expect(urlCreds).not.toContain("customKeySecret000");

    const t0 = Date.now();
    const pathological = '{"set-cookie":["' + "a".repeat(50000) + '", "b=secret"';
    redactSecrets(pathological);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  test("buildChatExpression preserves conversationId, resumeToken, and finished answer across multi-event SSE chunks", async () => {
    const modSrc = `
      export const Ymr = {
        safeGet: async (p) => p === "/ios/attestation_challenge"
          ? { attestation_challenge: "ch-multi-sse" }
          : { mapping: {} },
        streamPost: (_p, init) => {
          init.onStreamData(
            "data: " + JSON.stringify({ conversation_id: "conv-chunk-1" }) + "\\n\\n" +
            "data: " + JSON.stringify({ type: "resume_conversation_token", token: "resume-tok-1" }) + "\\n\\n" +
            "data: " + JSON.stringify({
              message: {
                author: { role: "assistant" },
                status: "finished_successfully",
                channel: "final",
                recipient: "all",
                content: { content_type: "text", parts: ["multi-event-answer"] },
                create_time: 10,
                metadata: { model_slug: "gpt-6-thinking" },
              },
            }) + "\\n\\n" +
            "data: " + JSON.stringify({ type: "message_stream_complete" }) + "\\n\\n" +
            "data: [DONE]\\n\\n",
          );
          init.onComplete({});
        },
        cancelStream: () => {},
      };
    `;
    const dataUrl = `data:text/javascript,${encodeURIComponent(modSrc + "\n//")}#/assets/app-shared-multievent.js`;
    const expr = buildChatExpression({ prompt: "hi", model: "gpt-6-thinking", effort: "standard" });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const res = await new AsyncFunction("performance", "document", "localStorage", `return await ${expr};`)(
      { getEntriesByType: () => [{ name: dataUrl }] },
      { querySelectorAll: () => [] },
      { getItem: () => "[]", setItem: () => {} },
    );
    expect(res.answer).toBe("multi-event-answer");
    expect(res.conversationId).toBe("conv-chunk-1");
  });
});
