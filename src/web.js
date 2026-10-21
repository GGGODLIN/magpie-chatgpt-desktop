// 第二個帳號（公司 Business workspace）的網頁版 provider：驅動專用 Chrome Beta 的已登入 chatgpt.com。
// 同一個 ChatGPT.app 掛不了第二個帳號（App 送出層有身分防護），日常 Chrome 每條 CDP 連線都要人按允許，
// 所以改連獨立 user-data-dir 的 Chrome Beta（2026-10-21 實測）。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatGPTDesktopError, formatMessagesToPrompt, normalizeThinkingEffort } from "./core.js";

export const WEB_DEFAULT_PORT = 19444;
// Magpie 的 plugin 宿主把 HOME 改到 ~/.magpie-machine/home，os.homedir() 會指錯；用系統帳號的家目錄。
const WEB_HOME = path.join(os.userInfo().homedir, ".local/share/chatgpt-web-biz");
const DAY_MS = 24 * 60 * 60 * 1000;
const WEB_MODELS = [
  { slug: "gpt-6-thinking", name: "GPT-6 Thinking (web)", reasoning: true, context: 262144 },
  { slug: "gpt-6-instant", name: "GPT-6 Instant (web)", reasoning: false, context: 52815 },
  { slug: "gpt-5-6-thinking", name: "GPT-5.6 Sol Thinking (web)", reasoning: true, context: 262144 },
];

// 網頁版只能從畫面送出（送出前要 sentinel 運算量證明與 Turnstile，由頁面自己產生）；
// 畫面上只打一個佔位字元，再在網路層換成真正的 prompt、模型與思考強度，免得把長文打進輸入框。
export const rewriteConversationBody = (body, { prompt, model, effort }) => {
  const out = { ...body, model: model ?? body.model };
  out.messages = (body.messages ?? []).map((message, index) =>
    index === 0 ? { ...message, content: { ...message.content, content_type: "text", parts: [prompt] } } : message);
  delete out.thinking_effort;
  const normalized = normalizeThinkingEffort(effort, out.model);
  if (normalized && /thinking|-pro$/.test(out.model)) out.thinking_effort = normalized;
  return out;
};

export const extractFinalAnswer = (conversation) => {
  const messages = Object.values(conversation?.mapping ?? {})
    .map((node) => node?.message)
    .filter((message) => message?.author?.role === "assistant"
      && message.content?.content_type === "text"
      && (message.channel ?? "final") === "final")
    .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  const last = messages.at(-1);
  if (!last) return null;
  // GPT-6 對純 JSON/XML 回答會包一層 <escape>（桌面版 core.js 的 unwrapDilEscape 同理；那份在 renderer 字串裡共用不到）。
  const raw = (last.content.parts ?? []).filter((part) => typeof part === "string").join("").trim();
  return {
    text: raw.startsWith("<escape>") && raw.endsWith("</escape>") ? raw.slice(8, -9).trim() : raw,
    status: last.status ?? null,
    model: last.metadata?.model_slug ?? null,
  };
};

// 每日預算記在檔案：Magpie 重載 plugin 不會歸零，也不必依賴頁面的 localStorage。
export const checkDailyBudget = (sends, budget, now = Date.now()) => {
  const recent = sends.filter((at) => typeof at === "number" && now - at < DAY_MS);
  if (typeof budget !== "number" || recent.length < budget) return { ok: true, recent };
  return { ok: false, recent, retryAfterMs: Math.max(60000, recent[recent.length - budget] + DAY_MS - now) };
};

const readSends = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rateLimited = (message, retryAfterMs) => new ChatGPTDesktopError(message, {
  stage: "rate_limited", retrySafe: true, status: 429, details: { retryAfterMs },
});

const unavailable = (message, stage, retryAfterMs = 60000) => new ChatGPTDesktopError(message, {
  stage, retrySafe: true, status: 503, details: { retryAfterMs },
});

const browserVersion = async (cdpUrl) => {
  const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
  return response.json();
};

// Chrome 沒開就用啟動腳本開（放螢幕外、不節流）；不在背景常駐，用到才開。
const ensureBrowser = async ({ cdpUrl, launcher }) => {
  try { return await browserVersion(cdpUrl); } catch {}
  if (!launcher || !fs.existsSync(launcher)) {
    throw unavailable("公司網頁版 Chrome 沒開，也找不到啟動腳本（CDP unreachable）", "cdp_unreachable");
  }
  spawn(launcher, [], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try { return await browserVersion(cdpUrl); } catch {}
  }
  throw unavailable("公司網頁版 Chrome 啟動後 20 秒仍連不上（CDP unreachable）", "cdp_unreachable");
};

const openSession = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(unavailable("連不上公司網頁版 Chrome（CDP websocket）", "cdp_unreachable")), { once: true });
  });
  let nextId = 0;
  const waiters = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (waiters.has(message.id)) { waiters.get(message.id)(message); waiters.delete(message.id); }
    else for (const listener of listeners) listener(message);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++nextId;
    waiters.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, listeners, close: () => ws.close() };
};

export const sendWebConversation = async ({
  cdpUrl = `http://127.0.0.1:${WEB_DEFAULT_PORT}`,
  launcher = path.join(WEB_HOME, "launch.sh"),
  expectedEmail,
  prompt,
  model = "gpt-6-thinking",
  effort,
  timeoutMs = 420000,
  dailyBudget = 200,
  budgetFile = path.join(WEB_HOME, "sends.json"),
  signal,
}) => {
  const budget = checkDailyBudget(readSends(budgetFile), dailyBudget);
  if (!budget.ok) throw rateLimited(`公司網頁版已用完 24 小時預算（${budget.recent.length}/${dailyBudget}）`, budget.retryAfterMs);

  const version = await ensureBrowser({ cdpUrl, launcher });
  const cdp = await openSession(version.webSocketDebuggerUrl);
  const started = Date.now();
  let targetId = null;
  try {
    // 獨立視窗：背景分頁不會渲染，找不到輸入框（2026-10-21 實測）。
    targetId = (await cdp.send("Target.createTarget", {
      url: "https://chatgpt.com/?temporary-chat=true", newWindow: true, left: -2400, top: 0, width: 900, height: 800,
    })).result?.targetId;
    if (!targetId) throw unavailable("公司網頁版開不了分頁", "cdp_unreachable");
    const sessionId = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
    const evaluate = async (expression) => {
      const reply = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.result?.exceptionDetails) throw unavailable("公司網頁版頁面執行失敗：" + String(reply.result.exceptionDetails.exception?.description ?? "").slice(0, 200), "renderer_timeout");
      return reply.result?.result?.value;
    };

    let conversationId = null;
    let postStatus = null;
    let rewritten = false;
    cdp.listeners.add(async (message) => {
      if (message.sessionId !== sessionId) return;
      const params = message.params ?? {};
      if (message.method === "Fetch.requestPaused") {
        const url = params.request.url;
        if (/\/backend-api\/f\/conversation$/.test(url) && params.request.postData && !rewritten) {
          rewritten = true;
          const body = rewriteConversationBody(JSON.parse(params.request.postData), { prompt, model, effort });
          await cdp.send("Fetch.continueRequest", { requestId: params.requestId, postData: Buffer.from(JSON.stringify(body)).toString("base64") }, sessionId);
        } else {
          await cdp.send("Fetch.continueRequest", { requestId: params.requestId }, sessionId);
        }
      }
      if (message.method === "Network.requestWillBeSent" && /\/backend-api\//.test(params.request.url)) {
        const match = params.request.url.match(/\/conversation\/([0-9a-f-]{36})/)
          ?? String(params.request.postData ?? "").match(/"conversation_id":"([0-9a-f-]{36})"/);
        if (match) conversationId ??= match[1];
      }
      if (message.method === "Network.responseReceived" && /\/backend-api\/f\/conversation$/.test(params.response.url)) {
        postStatus = params.response.status;
      }
    });
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*backend-api/f/conversation*", requestStage: "Request" }] }, sessionId);

    const api = async (apiPath, method = "GET", body = null) => evaluate(`(async () => {
      const token = (await (await fetch("/api/auth/session")).json()).accessToken;
      const response = await fetch(${JSON.stringify("/backend-api" + apiPath)}, { method: ${JSON.stringify(method)},
        headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ""} });
      return { status: response.status, body: await response.text() };
    })()`);

    // 鎖帳號：設定檔被切走或登出時寧可不送，也不能吃到別的帳號額度。
    let session = null;
    for (let i = 0; i < 20 && !session?.user; i++) {
      await sleep(500);
      session = await evaluate(`fetch("/api/auth/session").then(r => r.json()).catch(() => null)`).catch(() => null);
    }
    const email = session?.user?.email ?? null;
    if (!expectedEmail) throw unavailable("公司網頁版沒設定預期帳號，不送出", "account_mismatch", 10 * 60 * 1000);
    if (!email || email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw unavailable(`公司網頁版未登入預期帳號（目前：${email ?? "未登入"}）`, "account_mismatch", 10 * 60 * 1000);
    }

    const focused = await evaluate(`(async () => {
      for (let i = 0; i < 30; i++) {
        const editor = document.querySelector("[data-chatgpt-composer] [contenteditable=true]");
        if (editor) { editor.focus(); return true; }
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })()`);
    if (!focused) throw unavailable("公司網頁版找不到輸入框（頁面改版或沒渲染）", "client_not_found");
    // 頁面剛載入時編輯器可能還沒接上 React，打進去的字不算數、送出鈕維持停用；等不到就重打一次。
    let clicked = false;
    for (let attempt = 0; attempt < 2 && !clicked; attempt++) {
      await cdp.send("Input.insertText", { text: "." }, sessionId);
      clicked = await evaluate(`(async () => {
        for (let i = 0; i < 16; i++) {
          const button = [...document.querySelectorAll("[data-chatgpt-composer] button")].find((b) => /^(傳送|Send)/.test(b.getAttribute("aria-label") ?? ""));
          if (button && !button.disabled) { button.click(); return true; }
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      })()`);
    }
    if (!clicked) throw unavailable("公司網頁版送出按鈕不可用", "client_not_found");
    try {
      const sends = checkDailyBudget(readSends(budgetFile), null).recent;
      fs.writeFileSync(budgetFile, JSON.stringify([...sends, Date.now()]));
    } catch {}

    while (!conversationId && !(postStatus >= 400) && Date.now() - started < 90000) {
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
      await sleep(500);
    }
    if (postStatus === 429 || postStatus === 403) {
      throw rateLimited(`公司網頁版拒收（HTTP ${postStatus}）`, postStatus === 403 ? 15 * 60 * 1000 : 10 * 60 * 1000);
    }
    if (postStatus >= 400) throw unavailable(`公司網頁版送出失敗（HTTP ${postStatus}）`, "send_rejected");
    if (!conversationId) throw rateLimited("公司網頁版送出後 90 秒沒拿到對話 ID", 30000);

    // 跟桌面版撈答案同一套：stream_status 不吃讀取額度，結束後才讀一次整段對話。
    let streamStatus = null;
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
      const reply = await api(`/conversation/${conversationId}/stream_status`);
      if (reply.status === 429) throw rateLimited("公司網頁版讀取被限流（stream_status 429）", 10 * 60 * 1000);
      streamStatus = reply.status === 200 ? JSON.parse(reply.body).status : `http${reply.status}`;
      if (streamStatus !== "IS_STREAMING") break;
      await sleep(5000);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await api(`/conversation/${conversationId}`);
      if (reply.status === 429) throw rateLimited("公司網頁版讀取被限流（conversation 429）", 10 * 60 * 1000);
      if (reply.status !== 200) throw rateLimited(`公司網頁版讀不到對話（HTTP ${reply.status}）`, 30000);
      const answer = extractFinalAnswer(JSON.parse(reply.body));
      if (answer?.status === "finished_successfully" && answer.text) {
        return { answer: answer.text, model: answer.model ?? model, conversationId, streamStatus, ms: Date.now() - started };
      }
      await sleep(5000);
    }
    throw rateLimited(`公司網頁版回答停在半截（串流狀態 ${streamStatus}）`, 30000);
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
};

const errorResponse = (error) => {
  const retryAfterMs = error?.details?.retryAfterMs ?? 60000;
  const status = error?.status === 429 ? 429 : error?.status === 413 ? 413 : error?.status === 400 ? 400 : 503;
  return new Response(JSON.stringify({ error: { message: String(error?.message ?? error), type: error?.stage ?? "unavailable", code: error?.stage ?? "unavailable" } }), {
    status,
    headers: { "content-type": "application/json", "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
  });
};

export async function chatgptWebBizPlugin(_input, pluginOptions = {}) {
  const providerId = pluginOptions?.providerId ?? "chatgpt-web-biz";
  const cdpUrl = pluginOptions?.cdpUrl ?? `http://127.0.0.1:${WEB_DEFAULT_PORT}`;
  // 預期帳號放在本機設定檔、不進 repo；讀不到就一律不送（鎖帳號是硬條件）。
  const expectedEmail = () => {
    if (pluginOptions?.expectedEmail) return pluginOptions.expectedEmail;
    try {
      return JSON.parse(fs.readFileSync(path.join(WEB_HOME, "account.json"), "utf8")).email ?? null;
    } catch { return null; }
  };
  const modelEntries = Object.fromEntries(WEB_MODELS.map((m) => [m.slug, {
    id: m.slug, name: m.name, tool_call: false, attachment: false, reasoning: m.reasoning,
    modalities: { input: ["text"], output: ["text"] }, limit: { context: m.context, output: 0 },
  }]));
  return {
    async config(cfg) {
      cfg.provider ??= {};
      const existing = cfg.provider[providerId] ?? {};
      cfg.provider[providerId] = {
        ...existing,
        name: existing.name ?? "ChatGPT Web (Business)",
        npm: existing.npm ?? "@ai-sdk/openai-compatible",
        api: existing.api ?? "http://127.0.0.1/v1",
        models: existing.models ?? {},
      };
    },
    provider: { id: providerId, async models() { return modelEntries; } },
    auth: {
      provider: providerId,
      maxConcurrency: 1,
      methods: [{
        type: "oauth",
        label: "Connect ChatGPT web (dedicated Chrome Beta)",
        async authorize() {
          return {
            url: "",
            instructions: "Connecting to the dedicated Chrome Beta...",
            method: "auto",
            async callback() {
              try {
                await ensureBrowser({ cdpUrl, launcher: pluginOptions?.launcher ?? path.join(WEB_HOME, "launch.sh") });
                return { type: "success", refresh: cdpUrl, access: cdpUrl, expires: 0, accountId: expectedEmail() ?? "ChatGPT Web" };
              } catch (error) {
                return { type: "failed", error: String(error?.message ?? error) };
              }
            },
          };
        },
      }],
      async loader() {
        return {
          apiKey: providerId,
          baseURL: "http://127.0.0.1/v1",
          fetch: async (_url, init = {}) => {
            let payload;
            try { payload = JSON.parse(typeof init?.body === "string" ? init.body : String(init?.body ?? "{}")); }
            catch { return errorResponse(new ChatGPTDesktopError("無效的 JSON 請求內容", { stage: "unsupported_input", status: 400 })); }
            try {
              const effort = payload.reasoning_effort ?? payload.reasoning?.effort ?? "standard";
              const result = await sendWebConversation({
                cdpUrl,
                launcher: pluginOptions?.launcher,
                expectedEmail: expectedEmail(),
                prompt: formatMessagesToPrompt(payload.messages ?? payload.prompt),
                model: payload.model,
                effort,
                timeoutMs: pluginOptions?.chatTimeoutMs ?? 420000,
                dailyBudget: pluginOptions?.dailyBudget ?? 200,
                signal: init?.signal,
              });
              const id = `chatcmpl-${result.conversationId ?? crypto.randomUUID()}`;
              const created = Math.floor(Date.now() / 1000);
              if (payload.stream === true) {
                const chunk = (delta, finish) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: result.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
                return new Response(chunk({ role: "assistant", content: result.answer }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
                  status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
                });
              }
              return new Response(JSON.stringify({
                id, object: "chat.completion", created, model: result.model,
                choices: [{ index: 0, message: { role: "assistant", content: result.answer }, finish_reason: "stop" }],
              }), { status: 200, headers: { "content-type": "application/json" } });
            } catch (error) {
              return errorResponse(error);
            }
          },
        };
      },
    },
  };
}
