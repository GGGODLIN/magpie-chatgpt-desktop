import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../src/index.js";
import { RENDERER_URL, resetUnusualActivityCooldown } from "../src/core.js";

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  resetUnusualActivityCooldown();
});

const fixture = async ({ enabled = true, desktop = {}, models = ["gpt-6-thinking", "gpt-5-6-thinking"], email = "backup@example.test", actualModel, conversationStatus = 200 } = {}) => {
  const state = { sent: [], desktopCalls: 0, companyCalls: 0, closes: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "company-backup-test-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      const ws = `ws://127.0.0.1:${srv.port}`;
      if (url.pathname === "/json/list") return Response.json([{ type: "page", url: RENDERER_URL, webSocketDebuggerUrl: `${ws}/desktop` }]);
      if (url.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `${ws}/company` });
      if (srv.upgrade(request, { data: { desktop: url.pathname === "/desktop" } })) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const command = JSON.parse(String(raw));
        let result = {};
        if (ws.data.desktop) {
          state.desktopCalls += 1;
          result = { result: { value: { error: "quota refused", stage: "quota_exceeded", quotaRejected: true, retrySafe: true, ...desktop } } };
        } else {
          state.companyCalls += 1;
          if (command.method === "Target.getTargets") result = { targetInfos: [{ type: "page" }] };
          if (command.method === "Target.createTarget") result = { targetId: "company-tab" };
          if (command.method === "Target.attachToTarget") result = { sessionId: "company-session" };
          if (command.method === "Target.closeTarget") state.closes += 1;
          if (command.method === "Runtime.evaluate") {
            const expression = command.params.expression;
            let value;
            if (expression.includes("const token =")) {
              if (expression.includes("/models?")) value = { status: 200, body: JSON.stringify({ models: models.map(slug => ({ slug })) }) };
              else if (expression.includes("/stream_status")) value = { status: 200, body: JSON.stringify({ status: "COMPLETE" }) };
              else value = { status: conversationStatus, body: JSON.stringify({ mapping: { final: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["company answer"] }, status: "finished_successfully", metadata: { model_slug: actualModel ?? state.sent.at(-1)?.model } } } } }) };
            } else if (expression.includes("/api/auth/session")) value = { user: { email } };
            else if (expression.includes("button.click()")) {
              value = true;
              ws.send(JSON.stringify({ method: "Fetch.requestPaused", sessionId: "company-session", params: { requestId: "send", request: { url: "https://chatgpt.com/backend-api/f/conversation", postData: JSON.stringify({ messages: [{ content: { parts: ["."] } }] }) } } }));
            } else value = true;
            result = { result: { value } };
          }
          if (command.method === "Fetch.continueRequest" && command.params.postData) {
            state.sent.push(JSON.parse(Buffer.from(command.params.postData, "base64").toString()));
            ws.send(JSON.stringify({ method: "Network.requestWillBeSent", sessionId: "company-session", params: { request: { url: "https://chatgpt.com/backend-api/conversation/11111111-1111-1111-1111-111111111111" } } }));
          }
        }
        ws.send(JSON.stringify({ id: command.id, result }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ running: true, cdpUrl: `http://127.0.0.1:${server.port}` }));
  const instance = await plugin({ magpie: { option: (_id, key) => key === "company_fallback" ? enabled : true } }, {
    stateFile,
    companyBackup: { cdpUrl: `http://127.0.0.1:${server.port}`, expectedEmail: "backup@example.test", budgetFile: path.join(dir, "sends.json") },
  });
  return { state, loader: await instance.auth.loader(() => null) };
};

const ask = (loader, model = "gpt-6-thinking", effort = "high", stream = false) => loader.fetch("http://fixture/v1/chat/completions", {
  method: "POST", body: JSON.stringify({ model, reasoning_effort: effort, stream, messages: [{ role: "user", content: "same prompt" }] }),
});

describe("same-model company account backup", () => {
  test("keeps each requested model, effort and prompt; company backup takes precedence over Instant downgrade", async () => {
    const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { state, loader } = await fixture({
      desktop: {
        stage: "quota_exceeded",
        quotaRejected: true,
        resetsAt,
        limitedModels: { "gpt-6-thinking": resetsAt, "gpt-5-6-thinking": resetsAt },
      },
    });
    for (const [model, effort, expected] of [["gpt-6-thinking", "high", "extended"], ["gpt-5-6-thinking", "low", "min"]]) {
      resetUnusualActivityCooldown();
      const response = await ask(loader, model, effort);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-ChatGPT-Account-Source")).toBe("company");
      const body = await response.json();
      expect(body.model).toBe(model);
      expect(body.choices[0].message.content).toBe("company answer");
      expect(state.sent.at(-1).model).toBe(model);
      expect(state.sent.at(-1).thinking_effort).toBe(expected);
      expect(state.sent.at(-1).messages[0].content.parts[0]).toContain("same prompt");
      expect(state.sent.at(-1).history_and_training_disabled).toBe(true);
      expect(state.sent.at(-1).is_do_not_remember).toBe(true);
    }
    expect(state.desktopCalls).toBe(1);
    expect(state.sent).toHaveLength(2);
    expect(state.closes).toBe(2);
  });

  test("passes SSE responses through with the requested model", async () => {
    const { loader } = await fixture();
    const response = await ask(loader, "gpt-6-thinking", "high", true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"model":"gpt-6-thinking"');
    expect(text).toContain("company answer");
    expect(text).toContain("[DONE]");
  });

  test("refuses a model missing from the company catalog before sending", async () => {
    const { state, loader } = await fixture({ models: ["gpt-5-6-thinking"] });
    const response = await ask(loader);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("model_not_available");
    expect(state.sent).toHaveLength(0);
  });

  test("reports an upstream model substitution without retrying", async () => {
    const { state, loader } = await fixture({ actualModel: "gpt-6-instant" });
    const response = await ask(loader);
    expect(response.status).toBe(502);
    expect(response.headers.get("X-Should-Retry")).toBe("false");
    expect((await response.json()).error.code).toBe("model_mismatch");
    expect(state.sent).toHaveLength(1);
  });

  test("does not permit resending when the company answer cannot be read", async () => {
    const { state, loader } = await fixture({ conversationStatus: 404 });
    const response = await ask(loader);
    expect(response.status).toBe(502);
    expect(response.headers.get("X-Should-Retry")).toBe("false");
    expect((await response.json()).error.code).toBe("unknown_send_state");
    expect(state.sent).toHaveLength(1);
  });

  test("refuses a different company account before sending", async () => {
    const { state, loader } = await fixture({ email: "other@example.test" });
    const response = await ask(loader);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("account_mismatch");
    expect(state.sent).toHaveLength(0);
  });

  test("switches the same request once after an incomplete conversation or unknown Desktop state", async () => {
    for (const desktop of [
      { stage: "rate_limited", accountCooldown: false, conversationId: "already-sent", assistantSeen: true, retryAfterMs: 30000 },
      { stage: "unknown_send_state", retrySafe: false },
      { stage: "cdp_unreachable", quotaRejected: false },
    ]) {
      resetUnusualActivityCooldown();
      const { state, loader } = await fixture({ desktop });
      const response = await ask(loader, "gpt-5-6-thinking", "high");
      expect(response.status).toBe(200);
      expect((await response.json()).model).toBe("gpt-5-6-thinking");
      expect(state.desktopCalls).toBe(1);
      expect(state.sent).toHaveLength(1);
      expect(state.sent[0].thinking_effort).toBe("extended");
    }
  });

  test("does not freeze the personal Desktop account after a single-request stall or disconnect", async () => {
    const { state, loader } = await fixture({
      desktop: { stage: "rate_limited", accountCooldown: false, conversationId: "stalled-once", assistantSeen: true, retryAfterMs: 30000 },
    });
    expect((await ask(loader, "gpt-5-6-thinking", "high")).status).toBe(200);
    expect(state.desktopCalls).toBe(1);
    expect((await ask(loader, "gpt-5-6-thinking", "high")).status).toBe(200);
    expect(state.desktopCalls).toBe(2);
    expect(state.sent).toHaveLength(2);
  });

  test("cools down only the quota-limited models so unlocked Instant models still try Desktop first", async () => {
    const resetsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { state, loader } = await fixture({
      models: ["gpt-6-thinking", "gpt-5-6-thinking", "gpt-6-instant"],
      desktop: {
        stage: "quota_exceeded",
        quotaRejected: true,
        resetsAt,
        limitedModels: { "gpt-6-thinking": resetsAt, "gpt-5-6-thinking": resetsAt },
      },
    });
    expect((await ask(loader, "gpt-6-thinking", "high")).status).toBe(200);
    expect(state.desktopCalls).toBe(1);
    // 同一波被鎖的 gpt-5-6-thinking 直接走公司帳號，不重打 Desktop
    expect((await ask(loader, "gpt-5-6-thinking", "low")).status).toBe(200);
    expect(state.desktopCalls).toBe(1);
    // 未被鎖的 gpt-6-instant 仍會先走個人 Desktop
    expect((await ask(loader, "gpt-6-instant", "low")).status).toBe(200);
    expect(state.desktopCalls).toBe(2);
  });

  test("does not send to either account when cancelled", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "unknown_send_state", retrySafe: false } });
    const controller = new AbortController();
    controller.abort();
    await loader.fetch("http://fixture/v1/chat/completions", {
      signal: controller.signal,
      body: JSON.stringify({ model: "gpt-6-thinking", messages: [{ role: "user", content: "cancelled" }] }),
    });
    expect(state.sent).toHaveLength(0);
  });

  test("reports both-account failure without resending the company request", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "rate_limited", conversationId: "already-sent", retryAfterMs: 30000 }, conversationStatus: 404 });
    const response = await ask(loader);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("unknown_send_state");
    expect(state.desktopCalls).toBe(1);
    expect(state.sent).toHaveLength(1);
  });

  test("does not switch accounts for invalid input", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "unsupported_input", quotaRejected: false } });
    const response = await ask(loader);
    expect(response.status).not.toBe(200);
    expect(state.companyCalls).toBe(0);
  });

  test("backs up the current request and keeps subsequent requests on the company during Desktop account cooldown", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "rate_limited", accountCooldown: true, retryAfterMs: 30000 } });
    const first = await ask(loader, "gpt-5-6-thinking", "high");
    expect(first.status).toBe(200);
    expect(state.sent).toHaveLength(1);
    const next = await ask(loader, "gpt-6-thinking", "low");
    expect(next.status).toBe(200);
    expect(state.desktopCalls).toBe(1);
    expect(state.sent).toHaveLength(2);
    expect(state.sent[1].model).toBe("gpt-6-thinking");
    expect(state.sent[1].thinking_effort).toBe("min");
  });

  test("keeps a request spaced one minute later on the company backup", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "rate_limited", accountCooldown: true, retryAfterMs: 30000 } });
    expect((await ask(loader)).status).toBe(200);
    const now = Date.now;
    const started = now();
    try {
      Date.now = () => started + 61000;
      expect((await ask(loader)).status).toBe(200);
      expect(state.desktopCalls).toBe(1);
      expect(state.sent).toHaveLength(2);
    } finally {
      Date.now = now;
    }
  });

  test("backs up recovery attempts too and extends the wait after repeated Desktop failures", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "rate_limited", accountCooldown: true, retryAfterMs: 30000 } });
    expect((await ask(loader)).status).toBe(200);
    const now = Date.now;
    const started = now();
    try {
      Date.now = () => started + 301000;
      expect((await ask(loader)).status).toBe(200);
      expect(state.desktopCalls).toBe(2);
      Date.now = () => started + 602000;
      expect((await ask(loader)).status).toBe(200);
      expect(state.desktopCalls).toBe(2);
      Date.now = () => started + 902000;
      expect((await ask(loader)).status).toBe(200);
      expect(state.desktopCalls).toBe(3);
      expect(state.sent).toHaveLength(4);
    } finally {
      Date.now = now;
    }
  });

  test("does not shorten an explicit longer Desktop cooldown", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "rate_limited", accountCooldown: true, retryAfterMs: 7 * 60 * 60 * 1000 } });
    expect((await ask(loader)).status).toBe(200);
    const now = Date.now;
    const started = now();
    try {
      Date.now = () => started + 6 * 60 * 60 * 1000;
      expect((await ask(loader)).status).toBe(200);
      expect(state.desktopCalls).toBe(1);
    } finally {
      Date.now = now;
    }
  });

  test("does not contact the company account while the option is off", async () => {
    const { state, loader } = await fixture({ enabled: false, desktop: { stage: "rate_limited", retryAfterMs: 30000 } });
    const response = await ask(loader);
    expect(response.status).toBe(429);
    expect(state.companyCalls).toBe(0);
  });

  test("the backup option defaults off", async () => {
    const instance = await plugin({});
    expect(instance.auth.options.find(option => option.key === "company_fallback").default).toBe(false);
  });
});
