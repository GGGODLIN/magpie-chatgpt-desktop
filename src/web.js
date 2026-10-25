// 第二個帳號（公司 Business workspace）的網頁版 provider：驅動專用 Chrome Beta 的已登入 chatgpt.com。
// 同一個 ChatGPT.app 掛不了第二個帳號（App 送出層有身分防護），日常 Chrome 每條 CDP 連線都要人按允許，
// 所以改連獨立 user-data-dir 的 Chrome Beta（2026-10-21 實測）。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatGPTDesktopError, estimateTokenCount, formatMessagesToPrompt, normalizeThinkingEffort } from "./core.js";

export const WEB_DEFAULT_PORT = 19444;
// Magpie 的 plugin 宿主把 HOME 改到 ~/.magpie-machine/home，os.homedir() 會指錯；Bun 的
// os.userInfo().homedir 也跟著 HOME 走（Node 不會），所以用帳號名稱組 macOS 家目錄。
const REAL_HOME = path.join("/Users", os.userInfo().username);
const WEB_HOME = process.env.CHATGPT_WEB_BIZ_HOME ?? path.join(REAL_HOME, ".local/share/chatgpt-web-biz");
const DAY_MS = 24 * 60 * 60 * 1000;
const WEB_MODELS = [
  { slug: "gpt-6-thinking", name: "GPT-6 Thinking (web)", reasoning: true, context: 262144 },
  { slug: "gpt-6-instant", name: "GPT-6 Instant (web)", reasoning: false, context: 52815 },
  { slug: "gpt-5-6-thinking", name: "GPT-5.6 Sol Thinking (web)", reasoning: true, context: 262144 },
];

// 網頁版只能從畫面送出（送出前要 sentinel 運算量證明與 Turnstile，由頁面自己產生）；
// 畫面上只打一個佔位字元，再在網路層換成真正的 prompt、模型與思考強度，免得把長文打進輸入框。
export const rewriteConversationBody = (body, { prompt, model, effort }) => {
  // 不能只靠 ?temporary-chat=true：2026-10-21 公司帳號側邊欄出現背景請求留下的一般對話，頁面送出的內容並不一定帶暫時旗標。
  const out = { ...body, model: model ?? body.model, history_and_training_disabled: true, is_do_not_remember: true };
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
  // Chrome 靠 $HOME 找登入鑰匙圈解 cookie；用宿主改過的 HOME 啟動會解不開、整個設定檔等於被登出
  // （2026-10-21 實際把公司帳號登入弄丟過一次）。啟動腳本也會自己改回，這裡再保一層。
  spawn(launcher, [], { detached: true, stdio: "ignore", env: { ...process.env, HOME: REAL_HOME } }).unref();
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
  // 預設不設上限（使用者 2026-10-21 要先觀察真實用量）；sends.json 照常記錄，要恢復上限就傳數字。
  dailyBudget = null,
  budgetFile = path.join(WEB_HOME, "sends.json"),
  signal,
}) => {
  const budget = checkDailyBudget(readSends(budgetFile), dailyBudget);
  if (!budget.ok) throw rateLimited(`公司網頁版已用完 24 小時預算（${budget.recent.length}/${dailyBudget}）`, budget.retryAfterMs);

  const version = await ensureBrowser({ cdpUrl, launcher });
  const cdp = await openSession(version.webSocketDebuggerUrl);
  const started = Date.now();
  let targetId = null;
  let sendAttempted = false;
  let postStatus = null;
  try {
    // 每筆在常駐視窗裡開背景分頁：沒有任何視窗時 Chrome 會為分頁新開視窗、送完關掉，畫面一直閃；
    // 所以先留一個常駐視窗讓使用者自己縮到最小（加了不節流參數，背景分頁與最小化都照常渲染，2026-10-21 實測）。
    const pages = ((await cdp.send("Target.getTargets")).result?.targetInfos ?? []).filter((t) => t.type === "page");
    if (pages.length === 0) await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
    targetId = (await cdp.send("Target.createTarget", {
      url: "https://chatgpt.com/?temporary-chat=true", background: true,
    })).result?.targetId;
    if (!targetId) throw unavailable("公司網頁版開不了分頁", "cdp_unreachable");
    const sessionId = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).result.sessionId;
    // 頁面卡住（例如沒登入的新設定檔停在 Cloudflare 驗證頁）時不能無限等：2026-10-21 一筆因此卡滿 4 分鐘。
    const evaluate = async (expression) => {
      const reply = await Promise.race([
        cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
        sleep(30000).then(() => { throw unavailable("公司網頁版頁面 30 秒沒回應", "renderer_timeout"); }),
      ]);
      if (reply.result?.exceptionDetails) throw unavailable("公司網頁版頁面執行失敗：" + String(reply.result.exceptionDetails.exception?.description ?? "").slice(0, 200), "renderer_timeout");
      return reply.result?.result?.value;
    };

    let conversationId = null;
    let rewritten = false;
    cdp.listeners.add(async (message) => {
      if (message.sessionId !== sessionId) return;
      const params = message.params ?? {};
      if (message.method === "Fetch.requestPaused") {
        const url = params.request.url;
        if (/\/backend-api\/f\/conversation$/.test(url) && params.request.postData && !rewritten) {
          rewritten = true;
          const body = rewriteConversationBody(JSON.parse(params.request.postData), { prompt, model, effort });
          sendAttempted = true;
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

    const catalog = await api("/models?iim=false&include_icons=false&is_gizmo=false");
    if (catalog.status !== 200) throw unavailable("公司網頁版讀不到模型目錄，未送出", "catalog_unavailable");
    const availableModels = JSON.parse(catalog.body)?.models ?? [];
    if (!availableModels.some((entry) => entry.slug === model)) {
      throw new ChatGPTDesktopError(`公司帳號不支援原模型 ${model}，未送出，也未替換模型`, {
        stage: "model_not_available", status: 400,
      });
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
        if (answer.model && answer.model !== model) {
          throw new ChatGPTDesktopError(`公司帳號回覆模型 ${answer.model} 與原模型 ${model} 不符，未採用答案`, {
            stage: "model_mismatch", retrySafe: false, status: 502,
          });
        }
        // 網頁版不回 token 數，跟桌面版一樣用字元估算，讓 Magpie 的用量紀錄量得到公司帳號接了多少。
        const promptTokens = estimateTokenCount(prompt);
        const completionTokens = estimateTokenCount(answer.text);
        return {
          answer: answer.text, model: answer.model ?? model, conversationId, streamStatus, ms: Date.now() - started,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        };
      }
      await sleep(5000);
    }
    throw rateLimited(`公司網頁版回答停在半截（串流狀態 ${streamStatus}）`, 30000);
  } catch (error) {
    // 公司備援也可能已生成；沒有明確拒收時，禁止閘道或呼叫端再補送。
    if (sendAttempted && !(postStatus >= 400)) {
      throw new ChatGPTDesktopError(String(error?.message ?? error), {
        stage: error?.stage === "model_mismatch" ? "model_mismatch" : "unknown_send_state",
        retrySafe: false, status: 502,
      });
    }
    throw error;
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
};

const errorResponse = (error) => {
  const retryAfterMs = error?.details?.retryAfterMs ?? 60000;
  const status = error?.retrySafe === false ? 502 : error?.status === 429 ? 429 : error?.status === 413 ? 413 : error?.status === 400 ? 400 : 503;
  return new Response(JSON.stringify({ error: { message: String(error?.message ?? error), type: error?.stage ?? "unavailable", code: error?.stage ?? "unavailable" } }), {
    status,
    headers: { "content-type": "application/json", "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))), ...(error?.retrySafe === false ? { "X-Should-Retry": "false" } : {}) },
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
                dailyBudget: pluginOptions?.dailyBudget ?? null,
                budgetFile: pluginOptions?.budgetFile,
                signal: init?.signal,
              });
              const id = `chatcmpl-${result.conversationId ?? crypto.randomUUID()}`;
              const created = Math.floor(Date.now() / 1000);
              if (payload.stream === true) {
                const chunk = (delta, finish) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: result.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: result.usage } : {}) })}\n\n`;
                return new Response(chunk({ role: "assistant", content: result.answer }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
                  status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
                });
              }
              return new Response(JSON.stringify({
                id, object: "chat.completion", created, model: result.model,
                choices: [{ index: 0, message: { role: "assistant", content: result.answer }, finish_reason: "stop" }],
                usage: result.usage,
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
