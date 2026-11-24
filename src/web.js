// 第二個帳號（公司 Business workspace）的網頁版 provider：驅動專用 Chrome Beta 的已登入 chatgpt.com。
// 同一個 ChatGPT.app 掛不了第二個帳號（App 送出層有身分防護），日常 Chrome 每條 CDP 連線都要人按允許，
// 所以改連獨立 user-data-dir 的 Chrome Beta（2026-10-21 實測）。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChatGPTDesktopError,
  createSerialQueue,
  decodeBodyToString,
  estimateTokenCount,
  formatMessagesToPrompt,
  normalizeThinkingEffort,
  redactSecrets,
  safeJsonForJs,
} from "./core.js";

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
  const safeBody = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const outModel = model ?? safeBody.model;
  const out = { ...safeBody, model: outModel, history_and_training_disabled: true, is_do_not_remember: true };
  const rawMessages = Array.isArray(safeBody.messages) ? safeBody.messages : [];
  out.messages = rawMessages.map((message, index) =>
    index === 0 ? { ...message, content: { ...message?.content, content_type: "text", parts: [prompt] } } : message);
  delete out.thinking_effort;
  const normalized = normalizeThinkingEffort(effort, out.model);
  if (normalized && typeof out.model === "string" && /thinking|-pro$/.test(out.model)) out.thinking_effort = normalized;
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
  // GPT-6 對純 JSON/XML 回答會包一層 <escape>，且裸 JSON 結尾漏出 <| 時後端會把狀態卡在 in_progress。
  const raw = (last.content.parts ?? []).filter((part) => typeof part === "string").join("").trim();
  const ltPipe = raw.indexOf("<|");
  const withoutZombie = ltPipe !== -1 ? raw.slice(0, ltPipe).trim() : raw;
  const text = withoutZombie.startsWith("<escape>") && withoutZombie.endsWith("</escape>")
    ? withoutZombie.slice(8, -9).trim()
    : withoutZombie.startsWith("<escape>")
      ? withoutZombie.slice(8).replace(/<\/escape>\s*$/, "").trim()
      : withoutZombie;
  const zombieCompleted = last.status === "in_progress" && ltPipe !== -1 && text.length > 0;
  return {
    text,
    status: zombieCompleted ? "finished_successfully" : (last.status ?? null),
    model: last.metadata?.model_slug ?? null,
  };
};

export const checkDailyBudget = (sends, budget, now = Date.now()) => {
  const list = Array.isArray(sends) ? sends : [];
  const recent = list
    .filter((at) => typeof at === "number" && Number.isFinite(at) && now - at < DAY_MS)
    .sort((a, b) => a - b);
  if (typeof budget !== "number" || !Number.isFinite(budget) || recent.length < budget) {
    return { ok: true, recent };
  }
  const oldest = budget > 0 ? recent[recent.length - budget] : undefined;
  const retryAfterMs =
    typeof oldest === "number" && Number.isFinite(oldest)
      ? Math.max(60000, oldest + DAY_MS - now)
      : DAY_MS;
  return { ok: false, recent, retryAfterMs };
};

const readSends = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeSendsAtomic = (file, sends) => {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(sends), { mode: 0o600 });
    fs.renameSync(tmpFile, file);
  } catch (error) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
    }
    throw error;
  }
};

const safeParseJson = (text) => {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const decodeWsData = (data) => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data ?? "");
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", finish);
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", finish, { once: true });
    }
  });

const rateLimited = (message, retryAfterMs) => new ChatGPTDesktopError(message, {
  stage: "rate_limited", retrySafe: true, status: 429, details: { retryAfterMs },
});

const unavailable = (message, stage, retryAfterMs = 60000) => new ChatGPTDesktopError(message, {
  stage, retrySafe: true, status: 503, details: { retryAfterMs },
});

const browserVersion = async (cdpUrl, signal) => {
  if (signal?.aborted) throw unavailable("請求已取消", "aborted");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const onAbort = () => controller.abort();
  if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(`${cdpUrl}/json/version`, { signal: controller.signal });
    if (!response.ok) {
      throw unavailable(`公司網頁版 Chrome 回應異常（HTTP ${response.status}）`, "cdp_unreachable");
    }
    const data = safeParseJson(await response.text());
    if (typeof data?.webSocketDebuggerUrl !== "string" || !data.webSocketDebuggerUrl) {
      throw unavailable("公司網頁版 Chrome 缺少 webSocketDebuggerUrl", "cdp_unreachable");
    }
    return data;
  } catch (error) {
    if (signal?.aborted) throw unavailable("請求已取消", "aborted");
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort);
    }
  }
};

const ensureBrowser = async ({ cdpUrl, launcher, signal }) => {
  if (signal?.aborted) throw unavailable("請求已取消", "aborted");
  try {
    return await browserVersion(cdpUrl, signal);
  } catch (error) {
    if (signal?.aborted || error?.stage === "aborted") throw unavailable("請求已取消", "aborted");
  }
  if (!launcher || !fs.existsSync(launcher)) {
    throw unavailable("公司網頁版 Chrome 沒開，也找不到啟動腳本（CDP unreachable）", "cdp_unreachable");
  }
  spawn(launcher, [], { detached: true, stdio: "ignore", env: { ...process.env, HOME: REAL_HOME } }).unref();
  for (let i = 0; i < 20; i++) {
    if (signal?.aborted) throw unavailable("請求已取消", "aborted");
    await sleep(1000, signal);
    if (signal?.aborted) throw unavailable("請求已取消", "aborted");
    try {
      return await browserVersion(cdpUrl, signal);
    } catch (error) {
      if (signal?.aborted || error?.stage === "aborted") throw unavailable("請求已取消", "aborted");
    }
  }
  throw unavailable("公司網頁版 Chrome 啟動後 20 秒仍連不上（CDP unreachable）", "cdp_unreachable");
};

const openSession = async (wsUrl, { handshakeTimeoutMs = 10000, commandTimeoutMs = 30000, signal } = {}) => {
  if (signal?.aborted) throw unavailable("請求已取消", "aborted");
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    throw unavailable("連不上公司網頁版 Chrome（CDP websocket）", "cdp_unreachable");
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const cleanupHandshake = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      resolve();
    };
    const failHandshake = (err) => {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      try { ws.close(); } catch {}
      reject(err);
    };
    const onError = () => failHandshake(unavailable("連不上公司網頁版 Chrome（CDP websocket）", "cdp_unreachable"));
    const onClose = () => failHandshake(unavailable("公司網頁版 Chrome CDP 連線提早關閉", "cdp_unreachable"));
    const onAbort = () => failHandshake(unavailable("請求已取消", "aborted"));
    const timer = setTimeout(() => failHandshake(unavailable("公司網頁版 Chrome CDP 連線逾時", "cdp_unreachable")), handshakeTimeoutMs);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  let nextId = 0;
  let closed = false;
  const waiters = new Map();
  const listeners = new Set();

  const rejectAllWaiters = (err) => {
    closed = true;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    waiters.clear();
  };

  const rejectAbortableWaiters = () => {
    const err = unavailable("請求已取消", "aborted");
    for (const [id, waiter] of [...waiters.entries()]) {
      if (waiter.bypassAbort) continue;
      clearTimeout(waiter.timer);
      waiters.delete(id);
      waiter.reject(err);
    }
  };

  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(decodeWsData(event?.data));
    } catch {
      rejectAllWaiters(unavailable("公司網頁版 Chrome 回傳損毀的 CDP 訊息", "cdp_unreachable"));
      try { ws.close(); } catch {}
      return;
    }
    if (!message || typeof message !== "object") return;
    if (waiters.has(message.id)) {
      const waiter = waiters.get(message.id);
      waiters.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      for (const listener of [...listeners]) {
        Promise.resolve()
          .then(() => listener(message))
          .catch(() => {});
      }
    }
  };
  const onError = () => {
    rejectAllWaiters(unavailable("公司網頁版 Chrome CDP 連線中斷", "cdp_unreachable"));
  };
  const onClose = () => {
    rejectAllWaiters(unavailable("公司網頁版 Chrome CDP 連線已關閉", "cdp_unreachable"));
  };
  const onPostAbort = () => {
    rejectAbortableWaiters();
  };
  ws.addEventListener("message", onMessage);
  ws.addEventListener("error", onError);
  ws.addEventListener("close", onClose);
  if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onPostAbort, { once: true });
  }

  const send = (method, params = {}, sessionId, timeoutMs = commandTimeoutMs, { bypassAbort = false } = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(unavailable("公司網頁版 Chrome CDP 連線已關閉", "cdp_unreachable"));
      return;
    }
    if (!bypassAbort && signal?.aborted) {
      reject(unavailable("請求已取消", "aborted"));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(unavailable("公司網頁版頁面回應逾時", "renderer_timeout"));
    }, timeoutMs);
    waiters.set(id, { resolve, reject, timer, bypassAbort });
    try {
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch {
      clearTimeout(timer);
      waiters.delete(id);
      reject(unavailable("公司網頁版 Chrome CDP 傳送失敗", "cdp_unreachable"));
    }
  });

  const close = () => {
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", onPostAbort);
    }
    rejectAllWaiters(unavailable("公司網頁版 Chrome CDP 連線已關閉", "cdp_unreachable"));
    listeners.clear();
    ws.removeEventListener("message", onMessage);
    ws.removeEventListener("error", onError);
    ws.removeEventListener("close", onClose);
    try { ws.close(); } catch {}
  };

  return { send, listeners, close };
};

export const sendWebConversation = async ({
  cdpUrl = `http://127.0.0.1:${WEB_DEFAULT_PORT}`,
  launcher = path.join(WEB_HOME, "launch.sh"),
  expectedEmail,
  prompt,
  model = "gpt-6-thinking",
  effort,
  timeoutMs = 420000,
  dailyBudget = null,
  budgetFile = path.join(WEB_HOME, "sends.json"),
  signal,
}) => {
  if (signal?.aborted) throw unavailable("請求已取消", "aborted");
  const budget = checkDailyBudget(readSends(budgetFile), dailyBudget);
  if (!budget.ok) throw rateLimited(`公司網頁版已用完 24 小時預算（${budget.recent.length}/${dailyBudget}）`, budget.retryAfterMs);

  const version = await ensureBrowser({ cdpUrl, launcher, signal });
  const cdp = await openSession(version.webSocketDebuggerUrl, { signal });
  const started = Date.now();
  let targetId = null;
  let sendAttempted = false;
  let postStatus = null;
  try {
    const pages = ((await cdp.send("Target.getTargets")).result?.targetInfos ?? []).filter((t) => t.type === "page");
    if (pages.length === 0) await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
    targetId = (await cdp.send("Target.createTarget", {
      url: "https://chatgpt.com/?temporary-chat=true", background: true,
    })).result?.targetId;
    if (!targetId) throw unavailable("公司網頁版開不了分頁", "cdp_unreachable");
    const attachReply = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attachReply?.result?.sessionId;
    if (!sessionId || attachReply?.error) {
      throw unavailable("公司網頁版無法附加至分頁", "cdp_unreachable");
    }
    const evaluate = async (expression) => {
      const reply = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
        30000,
      );
      if (reply?.error) {
        throw unavailable(
          "公司網頁版頁面執行失敗：" + redactSecrets(reply.error.message ?? "").slice(0, 200),
          "renderer_timeout",
        );
      }
      if (reply?.result?.exceptionDetails) {
        throw unavailable(
          "公司網頁版頁面執行失敗：" + redactSecrets(reply.result.exceptionDetails.exception?.description ?? "").slice(0, 200),
          "renderer_timeout",
        );
      }
      return reply?.result?.result?.value;
    };

    let conversationId = null;
    let rewritten = false;
    cdp.listeners.add(async (message) => {
      if (message.sessionId !== sessionId) return;
      const params = message.params ?? {};
      if (message.method === "Fetch.requestPaused") {
        if (signal?.aborted) {
          await cdp.send(
            "Fetch.failRequest",
            { requestId: params.requestId, errorReason: "Aborted" },
            sessionId,
            1500,
            { bypassAbort: true },
          ).catch(() => {});
          return;
        }
        const url = String(params.request?.url ?? "");
        if (/\/backend-api\/f\/conversation$/.test(url) && params.request?.postData && !rewritten) {
          const parsedBody = safeParseJson(params.request.postData);
          if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
            rewritten = true;
            const body = rewriteConversationBody(parsedBody, { prompt, model, effort });
            sendAttempted = true;
            await cdp.send(
              "Fetch.continueRequest",
              { requestId: params.requestId, postData: Buffer.from(JSON.stringify(body)).toString("base64") },
              sessionId,
            ).catch(() => {});
            return;
          }
        }
        await cdp.send("Fetch.continueRequest", { requestId: params.requestId }, sessionId).catch(() => {});
      }
      if (message.method === "Network.requestWillBeSent" && /\/backend-api\//.test(String(params.request?.url ?? ""))) {
        const match = String(params.request.url).match(/\/conversation\/([0-9a-f-]{36})/)
          ?? String(params.request.postData ?? "").match(/"conversation_id":"([0-9a-f-]{36})"/);
        if (match) conversationId ??= match[1];
      }
      if (message.method === "Network.responseReceived" && /\/backend-api\/f\/conversation$/.test(String(params.response?.url ?? ""))) {
        postStatus = params.response.status;
      }
    });
    const networkEnabled = await cdp.send("Network.enable", {}, sessionId);
    if (networkEnabled?.error) {
      throw unavailable("公司網頁版無法啟用網路監聽，未送出", "cdp_unreachable");
    }
    const fetchEnabled = await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*backend-api/f/conversation*", requestStage: "Request" }] }, sessionId);
    if (fetchEnabled?.error) {
      throw unavailable("公司網頁版無法啟用請求攔截，未送出", "cdp_unreachable");
    }

    const api = async (apiPath, method = "GET", body = null) => evaluate(`(async () => {
      const auth = await fetch("/api/auth/session").then((r) => r.json()).catch(() => null);
      const token = auth?.accessToken ?? "";
      const response = await fetch(${safeJsonForJs("/backend-api" + apiPath)}, { method: ${safeJsonForJs(method)},
        headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": "application/json" }, ${body ? `body: ${safeJsonForJs(JSON.stringify(body))},` : ""} });
      return { status: response.status, body: await response.text() };
    })()`);

    let session = null;
    for (let i = 0; i < 20 && !session?.user; i++) {
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
      await sleep(500, signal);
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
      session = await evaluate(`fetch("/api/auth/session").then(r => r.json()).catch(() => null)`).catch(() => null);
    }
    const email = session?.user?.email ?? null;
    if (!expectedEmail) throw unavailable("公司網頁版沒設定預期帳號，不送出", "account_mismatch", 10 * 60 * 1000);
    if (!email || email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw unavailable(`公司網頁版未登入預期帳號（目前：${email ?? "未登入"}）`, "account_mismatch", 10 * 60 * 1000);
    }

    const catalog = await api("/models?iim=false&include_icons=false&is_gizmo=false");
    if (!catalog || catalog.status !== 200) throw unavailable("公司網頁版讀不到模型目錄，未送出", "catalog_unavailable");
    const parsedCatalog = safeParseJson(catalog.body);
    if (!parsedCatalog || !Array.isArray(parsedCatalog.models)) {
      throw unavailable("公司網頁版模型目錄格式異常，未送出", "catalog_unavailable");
    }
    const availableModels = parsedCatalog.models;
    if (!availableModels.some((entry) => entry?.slug === model)) {
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
    let clicked = false;
    for (let attempt = 0; attempt < 2 && !clicked; attempt++) {
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
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
      writeSendsAtomic(budgetFile, [...sends, Date.now()]);
    } catch {}

    while (!conversationId && !(postStatus >= 400) && Date.now() - started < 90000) {
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
      await sleep(500, signal);
    }
    if (postStatus === 429 || postStatus === 403) {
      throw rateLimited(`公司網頁版拒收（HTTP ${postStatus}）`, postStatus === 403 ? 15 * 60 * 1000 : 10 * 60 * 1000);
    }
    if (postStatus >= 400) throw unavailable(`公司網頁版送出失敗（HTTP ${postStatus}）`, "send_rejected");
    if (!conversationId) throw rateLimited("公司網頁版送出後 90 秒沒拿到對話 ID", 30000);

    let streamStatus = null;
    let statusPolls = 0;
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
      const reply = await api(`/conversation/${conversationId}/stream_status`);
      if (reply?.status === 429) throw rateLimited("公司網頁版讀取被限流（stream_status 429）", 10 * 60 * 1000);
      const parsedStatus = reply?.status === 200 ? safeParseJson(reply.body) : null;
      streamStatus = reply?.status === 200
        ? (parsedStatus?.status ?? "invalid_json")
        : `http${reply?.status ?? "error"}`;
      if (streamStatus !== "IS_STREAMING") break;
      statusPolls += 1;
      if (statusPolls % 4 === 0) {
        const probeConv = await api(`/conversation/${conversationId}`);
        if (probeConv?.status === 200) {
          const parsedProbe = safeParseJson(probeConv.body);
          const probeAns = parsedProbe ? extractFinalAnswer(parsedProbe) : null;
          if (probeAns?.status === "finished_successfully" && probeAns.text) break;
        }
      }
      await sleep(5000, signal);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw unavailable("請求已取消", "aborted");
      const reply = await api(`/conversation/${conversationId}`);
      if (reply?.status === 429) throw rateLimited("公司網頁版讀取被限流（conversation 429）", 10 * 60 * 1000);
      if (reply?.status !== 200) throw rateLimited(`公司網頁版讀不到對話（HTTP ${reply?.status ?? "error"}）`, 30000);
      const parsedConv = safeParseJson(reply.body);
      if (!parsedConv) throw rateLimited("公司網頁版對話回應非有效 JSON", 30000);
      const answer = extractFinalAnswer(parsedConv);
      if (answer?.status === "finished_successfully" && answer.text) {
        if (answer.model && answer.model !== model) {
          throw new ChatGPTDesktopError(`公司帳號回覆模型 ${answer.model} 與原模型 ${model} 不符，未採用答案`, {
            stage: "model_mismatch", retrySafe: false, status: 502,
          });
        }
        const promptTokens = estimateTokenCount(prompt);
        const completionTokens = estimateTokenCount(answer.text);
        return {
          answer: answer.text, model: answer.model ?? model, conversationId, streamStatus, ms: Date.now() - started,
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        };
      }
      await sleep(5000, signal);
    }
    throw rateLimited(`公司網頁版回答停在半截（串流狀態 ${streamStatus}）`, 30000);
  } catch (error) {
    if (sendAttempted && !(postStatus >= 400)) {
      throw new ChatGPTDesktopError(redactSecrets(error?.message ?? error), {
        stage: error?.stage === "model_mismatch" ? "model_mismatch" : "unknown_send_state",
        retrySafe: false, status: 502,
      });
    }
    throw error;
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }, undefined, 1500, { bypassAbort: true }).catch(() => {});
    cdp.close();
  }
};

const errorResponse = (error) => {
  const rawRetry = error?.details?.retryAfterMs;
  const retryAfterMs = typeof rawRetry === "number" && Number.isFinite(rawRetry) ? rawRetry : 60000;
  const status = error?.retrySafe === false ? 502 : error?.status === 429 ? 429 : error?.status === 413 ? 413 : error?.status === 400 ? 400 : 503;
  return new Response(
    JSON.stringify({
      error: {
        message: redactSecrets(error?.message ?? error),
        type: error?.stage ?? "unavailable",
        code: error?.stage ?? "unavailable",
      },
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        ...(error?.retrySafe === false ? { "X-Should-Retry": "false" } : {}),
      },
    },
  );
};

export async function chatgptWebBizPlugin(_input, pluginOptions = {}) {
  const providerId = pluginOptions?.providerId ?? "chatgpt-web-biz";
  const cdpUrl = pluginOptions?.cdpUrl ?? `http://127.0.0.1:${WEB_DEFAULT_PORT}`;
  const serialQueue = createSerialQueue();
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
                return { type: "failed", error: redactSecrets(error?.message ?? error) };
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
            try {
              payload = JSON.parse(decodeBodyToString(init?.body));
            } catch {
              return errorResponse(new ChatGPTDesktopError("無效的 JSON 請求內容", { stage: "unsupported_input", status: 400 }));
            }
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
              return errorResponse(new ChatGPTDesktopError("無效的 JSON 請求內容", { stage: "unsupported_input", status: 400 }));
            }
            try {
              if (
                (Array.isArray(payload.attachments) && payload.attachments.length > 0) ||
                (Array.isArray(payload.files) && payload.files.length > 0) ||
                payload.image != null ||
                payload.audio != null
              ) {
                throw new ChatGPTDesktopError("不支援非文字附件輸入", {
                  stage: "unsupported_input",
                  retrySafe: true,
                  status: 400,
                });
              }
              const formattedPrompt = formatMessagesToPrompt(payload.messages ?? payload.prompt);
              const effort = payload.reasoning_effort ?? payload.reasoning?.effort ?? "standard";
              const result = await serialQueue.run(
                () =>
                  sendWebConversation({
                    cdpUrl,
                    launcher: pluginOptions?.launcher,
                    expectedEmail: expectedEmail(),
                    prompt: formattedPrompt,
                    model: payload.model,
                    effort,
                    timeoutMs: pluginOptions?.chatTimeoutMs ?? 420000,
                    dailyBudget: pluginOptions?.dailyBudget ?? null,
                    budgetFile: pluginOptions?.budgetFile,
                    signal: init?.signal,
                  }),
                init?.signal,
              );
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
