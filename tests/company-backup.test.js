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
    const { state, loader } = await fixture();
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

  test("does not switch accounts after a conversation was created, on unknown state, or invalid input", async () => {
    for (const desktop of [
      { stage: "rate_limited", conversationId: "already-sent", retryAfterMs: 30000 },
      { stage: "unknown_send_state", retrySafe: false },
      { stage: "unsupported_input" },
    ]) {
      resetUnusualActivityCooldown();
      const { state, loader } = await fixture({ desktop });
      const response = await ask(loader);
      expect(response.status).not.toBe(200);
      if (desktop.stage === "rate_limited") {
        expect((await response.json()).error.message).toContain("conversation=true");
      }
      expect(state.companyCalls).toBe(0);
    }
  });

  test("sends the next new request to the company during Desktop cooldown without duplicating the failed request", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "rate_limited", conversationId: "already-sent", retryAfterMs: 30000 } });
    const first = await ask(loader, "gpt-5-6-thinking", "high");
    expect(first.status).toBe(429);
    expect(state.sent).toHaveLength(0);
    const next = await ask(loader, "gpt-6-thinking", "low");
    expect(next.status).toBe(200);
    expect(state.desktopCalls).toBe(1);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].model).toBe("gpt-6-thinking");
    expect(state.sent[0].thinking_effort).toBe("min");
  });

  test("tries Desktop again when its reported cooldown expires", async () => {
    const { state, loader } = await fixture({ desktop: { stage: "rate_limited", conversationId: "already-sent", retryAfterMs: 30000 } });
    expect((await ask(loader)).status).toBe(429);
    const now = Date.now;
    try {
      Date.now = () => now() + 31000;
      expect((await ask(loader)).status).toBe(429);
      expect(state.desktopCalls).toBe(2);
      expect(state.sent).toHaveLength(0);
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
