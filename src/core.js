import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CDP_PORT = 19333;
export const HIGH_PORT_MIN = 58000;
export const HIGH_PORT_MAX = 65000;
export const RENDERER_URL = "app://-/index.html";
export const MAX_PROMPT_BYTES = 500000;
export const UNUSUAL_ACTIVITY_COOLDOWN_MS = 3 * 60 * 1000;

let unusualActivityUntil = 0;

export const resetUnusualActivityCooldown = () => {
  unusualActivityUntil = 0;
};

export const estimateTokenCount = (text) => {
  const str = String(text ?? "");
  let ascii = 0;
  let other = 0;
  for (const ch of str) {
    if (ch.codePointAt(0) < 128) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.floor((ascii + 3) / 4) + other;
};

export class ChatGPTDesktopError extends Error {
  constructor(
    message,
    {
      stage = "unknown",
      retrySafe = true,
      status = 502,
      details = {},
      cause,
    } = {},
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ChatGPTDesktopError";
    this.stage = stage;
    this.retrySafe = Boolean(retrySafe);
    this.status = status;
    this.details = details ?? {};
  }
}

export const DEFAULT_CLIENT_EXPORTS = ["Ymr", "fTt"];

export const preferredClientExports = (env = process.env) => {
  const preferred = [];
  const rawOverride = String(env?.CODEX_ADVISOR_CLIENT_EXPORT ?? "").trim();
  const parts = rawOverride
    ? rawOverride.split(",")
    : DEFAULT_CLIENT_EXPORTS;
  for (const part of parts) {
    const name = part.trim();
    if (name && !preferred.includes(name)) {
      preferred.push(name);
    }
  }
  return preferred.length > 0 ? preferred : [...DEFAULT_CLIENT_EXPORTS];
};

export const parsePortFromCommandArgs = (commandLine) => {
  if (Array.isArray(commandLine)) {
    for (const line of commandLine) {
      const found = parsePortFromCommandArgs(line);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof commandLine !== "string" || !commandLine) return null;
  const match = commandLine.match(
    /--remote-debugging-port(?:=|\s+)["']?(\d+)(?=["']?(?:\s|$))/,
  );
  if (!match) return null;
  const port = Number.parseInt(match[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
};

export const parsePortOrCdpInput = (input) => {
  if (typeof input === "number") {
    if (Number.isInteger(input) && input >= 1 && input <= 65535) {
      return { port: input, cdpUrl: `http://127.0.0.1:${input}` };
    }
    return null;
  }
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const port = Number.parseInt(trimmed, 10);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { port, cdpUrl: `http://127.0.0.1:${port}` };
    }
    return null;
  }
  try {
    const parsedUrl = new URL(trimmed);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
    const port = Number.parseInt(parsedUrl.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      port,
      cdpUrl: `${parsedUrl.protocol}//${parsedUrl.host}`,
    };
  } catch {
    return null;
  }
};

export const checkPortFree = (port, host = "127.0.0.1") =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

export const findFreeHighPort = async ({
  min = HIGH_PORT_MIN,
  max = HIGH_PORT_MAX,
  host = "127.0.0.1",
  isPortFree = checkPortFree,
} = {}) => {
  for (let port = min; port <= max; port += 1) {
    const free = await isPortFree(port, host);
    if (free) return port;
  }
  return DEFAULT_CDP_PORT;
};

export const isChatGPTAppCommand = (line) =>
  /^(?:\S*\/)?ChatGPT\.app\/Contents\/MacOS\/ChatGPT(?:\s|$)/.test(
    String(line ?? "").trim(),
  );

let cachedPsLookup = { at: 0, port: null };
const PS_CACHE_TTL_MS = 1500;

export const detectRunningChatGPTPort = ({ execSyncImpl = execSync } = {}) => {
  const useDefaultExec = execSyncImpl === execSync;
  const now = Date.now();
  if (useDefaultExec && now - cachedPsLookup.at < PS_CACHE_TTL_MS) {
    return cachedPsLookup.port;
  }
  try {
    const output = String(
      execSyncImpl("/bin/ps -ax -o command=", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      }),
    );
    const lines = output.split(/\r?\n/).filter(isChatGPTAppCommand);
    const port = parsePortFromCommandArgs(lines);
    if (useDefaultExec) {
      cachedPsLookup = { at: Date.now(), port };
    }
    return port;
  } catch {
    return null;
  }
};

export const resolveCdpPort = async ({
  configuredPort,
  env = process.env,
  runningProcessArgs,
  detectRunningPort,
  isPortFree,
  forLaunch = false,
  minPort = HIGH_PORT_MIN,
  maxPort = HIGH_PORT_MAX,
  host = "127.0.0.1",
} = {}) => {
  const candidates = [
    configuredPort,
    env?.CHATGPT_CDP_PORT,
    env?.SIDECAR_CDP,
    env?.CODEX_CDP_PORT,
  ];
  for (const candidate of candidates) {
    const parsed = parsePortOrCdpInput(candidate);
    if (parsed !== null) {
      return { ...parsed, source: "configured" };
    }
  }

  let processPort = null;
  if (runningProcessArgs !== undefined) {
    processPort = parsePortFromCommandArgs(runningProcessArgs);
  } else if (typeof detectRunningPort === "function") {
    const detected = await detectRunningPort();
    processPort =
      typeof detected === "number"
        ? parsePortOrCdpInput(detected)?.port ?? null
        : parsePortFromCommandArgs(detected);
  } else {
    processPort = detectRunningChatGPTPort();
  }

  if (processPort !== null) {
    return {
      port: processPort,
      cdpUrl: `http://127.0.0.1:${processPort}`,
      source: "running_process",
    };
  }

  if (forLaunch) {
    const freePort = await findFreeHighPort({
      min: minPort,
      max: maxPort,
      host,
      isPortFree,
    });
    const isHigh = freePort >= minPort && freePort <= maxPort;
    return {
      port: freePort,
      cdpUrl: `http://127.0.0.1:${freePort}`,
      source: isHigh ? "high_port" : "default",
    };
  }

  return {
    port: DEFAULT_CDP_PORT,
    cdpUrl: `http://127.0.0.1:${DEFAULT_CDP_PORT}`,
    source: "default",
  };
};

export const getRendererTarget = async ({
  cdpUrl,
  fetchImpl = fetch,
  timeoutMs = 4000,
} = {}) => {
  const baseUrl = String(cdpUrl ?? `http://127.0.0.1:${DEFAULT_CDP_PORT}`).replace(
    /\/+$/,
    "",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let targets;
  try {
    const response = await fetchImpl(`${baseUrl}/json/list`, {
      signal: controller.signal,
    });
    if (!response || !response.ok) {
      throw new Error(`HTTP ${response?.status ?? "error"}`);
    }
    targets = await response.json();
    if (!Array.isArray(targets)) {
      throw new Error("Targets response is not an array");
    }
  } catch (error) {
    throw new ChatGPTDesktopError(`連不上 Codex Desktop 的 CDP（${baseUrl}）`, {
      stage: "cdp_unreachable",
      retrySafe: true,
      status: 503,
      details: { cdpUrl: baseUrl },
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  const pages = targets.filter(
    (target) =>
      Boolean(target) &&
      target.type === "page" &&
      target.url === RENDERER_URL,
  );
  if (pages.length !== 1) {
    throw new ChatGPTDesktopError(
      `主 renderer 不唯一，找到 ${pages.length} 個`,
      {
        stage: "renderer_not_unique",
        retrySafe: true,
        status: 503,
        details: { pageCount: pages.length, cdpUrl: baseUrl },
      },
    );
  }
  const page = pages[0];
  if (typeof page.webSocketDebuggerUrl !== "string" || !page.webSocketDebuggerUrl) {
    throw new ChatGPTDesktopError("主 renderer 缺少 webSocketDebuggerUrl", {
      stage: "renderer_not_unique",
      retrySafe: true,
      status: 503,
      details: { pageCount: 1, cdpUrl: baseUrl },
    });
  }
  return page;
};

// 已登入的 client 在 app-shared 或舊版 app-initial 裡的 export 名字每次改版都會變，
// 因此按方法形狀（safeGet/streamPost/cancelStream）並排除 [object RpcPromise] 假代理後，
// 以唯讀 attestation GET 實探才採用。
export const buildResolverJs = (
  preferredExports = preferredClientExports(),
) => `
  const preferredClientExports = ${JSON.stringify(preferredExports)};

  const isChatGPTClient = (value) => !!value
    && (typeof value === "object" || typeof value === "function")
    && String(value.safeGet) !== "[object RpcPromise]"
    && typeof value.safeGet === "function"
    && typeof value.streamPost === "function"
    && typeof value.cancelStream === "function";

  const chatGPTClientCandidates = (moduleNamespace) => {
    const names = Object.keys(moduleNamespace);
    const rest = names.filter((name) => !preferredClientExports.includes(name)).sort();
    const ordered = [
      ...preferredClientExports.filter((name) => names.includes(name)),
      ...rest.filter((name) => typeof moduleNamespace[name] === "object"),
      ...rest.filter((name) => typeof moduleNamespace[name] !== "object"),
    ];
    const seen = new Set();
    const candidates = [];
    for (const name of ordered) {
      const value = moduleNamespace[name];
      if (!isChatGPTClient(value) || seen.has(value)) continue;
      seen.add(value);
      candidates.push({ name, client: value });
    }
    return candidates;
  };

  const resolveChatGPTClient = async (moduleNamespace, probe) => {
    const candidates = chatGPTClientCandidates(moduleNamespace);
    const tried = [];
    for (const candidate of candidates) {
      try {
        const probeValue = await probe(candidate.client);
        return { client: candidate.client, exportName: candidate.name, probeValue, candidates: candidates.map((c) => c.name), tried };
      } catch (error) {
        tried.push({ name: candidate.name, error: String(error?.message ?? error) });
      }
    }
    return { client: null, exportName: null, candidates: candidates.map((c) => c.name), tried };
  };

  const clientModuleUrls = () => {
    const urls = [...new Set([
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
      ...[...document.querySelectorAll("script[src],link[href]")].map((node) => node.src ?? node.href),
    ])];
    const appSharedUrl = urls.find((url) => {
      const cleanPath = String(url ?? "").split("?")[0];
      return cleanPath.includes("/app-shared-") && cleanPath.endsWith(".js");
    });
    const appInitialUrl = urls.find((url) => {
      const cleanPath = String(url ?? "").split("?")[0];
      return cleanPath.includes("/app-initial-") && cleanPath.endsWith(".js");
    });
    return { appSharedUrl, appInitialUrl, primaryUrl: appSharedUrl ?? appInitialUrl };
  };

  const attestedClient = async () => {
    const { appSharedUrl, appInitialUrl, primaryUrl } = clientModuleUrls();
    if (!primaryUrl) return { error: "找不到 app-shared 或 app-initial 模組", stage: "module_not_found" };
    // 每筆都拿新 challenge、不快取：2026-10-20 被標記期間沿用快取 challenge 的請求幾秒內就被
    // 403「Unusual activity has been detected from your device」拒收；改成每筆新拿後 17 筆 0 拒收。
    const attestationProbe = (candidate) =>
      candidate.safeGet("/ios/attestation_challenge", {
        additionalHeaders: {
          "X-OpenAI-Attach-Desktop-Surface": "1",
          "X-OpenAI-Attach-DeviceCheck-Token": "1",
        },
      });
    let moduleUrl = primaryUrl;
    let resolved = await resolveChatGPTClient(await import(moduleUrl), attestationProbe);
    if (!resolved.client && appSharedUrl && appInitialUrl) {
      moduleUrl = appInitialUrl;
      resolved = await resolveChatGPTClient(await import(appInitialUrl), attestationProbe);
    }
    if (!resolved.client) {
      return {
        error: "renderer 裡沒有已登入的 client",
        stage: resolved.candidates.length === 0 ? "client_not_found" : "attestation_failed",
        clientCandidates: resolved.candidates,
        clientProbeErrors: resolved.tried,
        moduleUrl,
      };
    }
    return { ...resolved, moduleUrl };
  };
`;

export const buildProbeExpression = (
  preferredExports = preferredClientExports(),
) => `(async () => {
${buildResolverJs(preferredExports)}
  try {
    const resolved = await attestedClient();
    if (resolved.error) return resolved;
    return {
      clientExport: resolved.exportName,
      clientCandidates: resolved.candidates,
      clientProbeErrors: resolved.tried,
      moduleUrl: resolved.moduleUrl,
      challengeOk: typeof resolved.probeValue?.attestation_challenge === "string"
        && resolved.probeValue.attestation_challenge.length > 0,
    };
  } catch (error) {
    const msg = String(error?.message ?? error).trim();
    return { error: msg.length > 0 ? msg : "renderer 執行失敗" };
  }
})()`;

export const buildModelsExpression = (
  preferredExports = preferredClientExports(),
) => `(async () => {
${buildResolverJs(preferredExports)}
  try {
    const resolved = await attestedClient();
    if (resolved.error) return { ...resolved, retrySafe: true };
    const challenge = resolved.probeValue?.attestation_challenge;
    if (typeof challenge !== "string" || !challenge) {
      return {
        error: "拿不到 attestation challenge",
        stage: "attestation_failed",
        clientExport: resolved.exportName,
        retrySafe: true,
      };
    }
    const catalog = await resolved.client.safeGet("/models?iim=false&include_icons=false&is_gizmo=false", {});
    return {
      catalog,
      clientExport: resolved.exportName,
      moduleUrl: resolved.moduleUrl,
    };
  } catch (error) {
    const msg = String(error?.message ?? error).trim();
    return { error: msg.length > 0 ? msg : "renderer 執行失敗", retrySafe: true };
  }
})()`;

// OpenAI / Magpie 標準 reasoning_effort（low/medium/high/minimal/xhigh）與
// ChatGPT Desktop 內部 /f/conversation 的 thinking_effort（min/standard/extended/max）名稱不同；
// 直接原樣送出會導致 /f/conversation 拒絕連線，且 -pro 模型僅支援 standard。
export const normalizeThinkingEffort = (effort, modelSlug = "") => {
  const raw = String(effort ?? "").trim().toLowerCase();
  if (!raw) return "";
  const slug = String(modelSlug ?? "").trim().toLowerCase();
  if (slug.endsWith("-pro")) {
    return "standard";
  }
  switch (raw) {
    case "min":
    case "minimal":
    case "low":
    case "light":
      return "min";
    case "standard":
    case "medium":
    case "normal":
    case "default":
    case "none":
      return "standard";
    case "extended":
    case "high":
      return "extended";
    case "max":
    case "xhigh":
    case "heavy":
      return "max";
    default:
      return "standard";
  }
};

export const buildChatExpression = (
  options,
  preferredExports = preferredClientExports(),
) => {
  const normalizedOptions = {
    ...options,
    effort: normalizeThinkingEffort(options?.effort, options?.model),
  };
  return `(async () => {
  const coolingDown = () => {
    const waitMs = (globalThis.__magpieUnusualActivityUntil ?? 0) - Date.now();
    if (waitMs <= 0) return null;
    return {
      error: "ChatGPT Desktop 送出間隔冷卻中（rate_limit_exceeded），請稍後再試",
      stage: "rate_limited",
      accountCooldown: true,
      retrySafe: true,
      outcome: "cooldown",
      retryAfterMs: waitMs,
    };
  };
  if (coolingDown()) return coolingDown();
  const options = ${JSON.stringify(normalizedOptions)};
  const events = [];
  let sendAttempted = false;
  let streamError = null;
  let conversationId = null;
${buildResolverJs(preferredExports)}
  try {
    const resolved = await attestedClient();
    if (resolved.error) return { ...resolved, retrySafe: true };
    const client = resolved.client;
    let requestModel = options.model;
    if (options.instantFallback) {
      const catalog = await client.safeGet("/models?iim=false&include_icons=false&is_gizmo=false", {});
      const models = Array.isArray(catalog?.models) ? catalog.models : [];
      const isEligibleInstant = (preset) =>
        preset?.lane === "instant"
        && typeof preset?.model_slug === "string"
        && preset.model_slug.endsWith("-instant")
        && preset.preset_type === "available"
        && models.some((model) => model.slug === preset.model_slug && model.is_work_mode_model === false);
      const versions = Array.isArray(catalog?.versions) ? catalog.versions : [];
      const matchedVersion = versions.find((entry) => entry.enabled !== false
        && (entry.intelligence_presets ?? []).some((preset) => preset.model_slug === options.model
          && preset.preset_type === "available"));
      const instant = (matchedVersion?.intelligence_presets ?? []).find(isEligibleInstant);
      if (!instant) return { error: "模型目錄沒有可用的同版本 Instant", stage: "quota_exceeded", retrySafe: true };
      requestModel = instant.model_slug;
    }

    const challenge = resolved.probeValue?.attestation_challenge;
    if (typeof challenge !== "string" || !challenge) {
      return { error: "拿不到 attestation challenge", stage: "attestation_failed", clientExport: resolved.exportName, retrySafe: true };
    }

    const body = {
      action: "next",
      is_do_not_remember: true,
      // 暫時對話：背景請求不進側邊欄，免得淹沒本人的對話紀錄；2026-10-21 實測暫時對話仍有
      // conversation_id，stream_status 與 GET /conversation/{id} 都照常可讀，撈答案不受影響。
      history_and_training_disabled: true,
      messages: [{
        author: { role: "user" },
        channel: null,
        content: { content_type: "text", parts: [options.prompt] },
        create_time: Date.now() / 1000,
        end_turn: null,
        id: crypto.randomUUID(),
        metadata: {},
        recipient: "all",
        status: "finished_successfully",
        update_time: null,
        weight: 1,
      }],
      model: requestModel,
      supported_encodings: [],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset_min: new Date().getTimezoneOffset(),
      client_prepare_state: "none",
      app_attest_challenge: challenge,
    };
    if (!options.instantFallback && options.effort) body.thinking_effort = options.effort;

    // 前面的 await 期間可能已有別筆被拒收而啟動冷卻，送出前再看一次。
    const blocked = coolingDown();
    if (blocked) return blocked;
    // 被標記期間每筆送出都會在串流中途被插錯、只能靠撈答案；撈答案名額滿時再送只會白白生成一則
    // 沒人收的回答（2026-10-20 23:55 三分鐘內 17 筆這樣被丟掉），所以名額滿就不送。
    const flaggedRecently = Date.now() - (globalThis.__magpieSoftFlagAt ?? 0) < 10 * 60 * 1000;
    if (flaggedRecently && (globalThis.__magpieRecovering ?? 0) >= (globalThis.__magpieMaxRecovering ?? 2)) {
      return {
        error: "ChatGPT Desktop 撈答案名額已滿，暫不送出（rate_limit_exceeded）",
        stage: "rate_limited",
        retrySafe: true,
        outcome: "recovery_busy",
        retryAfterMs: 30000,
      };
    }

    // 帳號 24 小時訊息上限是 send 整個被鎖（2026-10-21 約 800～1,080 則後鎖 7 小時，使用者自己的 ChatGPT 也不能用），
    // 所以背景流量自己記數、到預算就停，留餘量給本人。存 localStorage 才撐得過外掛重啟與 App 重開。
    const DAY_MS = 24 * 60 * 60 * 1000;
    let sends = [];
    let storedBudget = null;
    try {
      sends = JSON.parse(localStorage.getItem("magpieSendTimes") ?? "[]")
        .filter((at) => typeof at === "number" && Date.now() - at < DAY_MS);
      const raw = Number(localStorage.getItem("magpieDailyBudget"));
      if (Number.isFinite(raw) && raw > 0) storedBudget = raw;
    } catch {}
    const dailyBudget = globalThis.__magpieDailyBudget ?? storedBudget ?? options.dailyBudget ?? null;
    if (typeof dailyBudget === "number" && sends.length >= dailyBudget) {
      return {
        error: "ChatGPT Desktop 已用完 24 小時預算（" + sends.length + "/" + dailyBudget + "，rate_limit_exceeded）",
        stage: "rate_limited",
        retrySafe: true,
        outcome: "daily_budget",
        retryAfterMs: Math.max(60000, sends[sends.length - dailyBudget] + DAY_MS - Date.now()),
      };
    }
    try {
      localStorage.setItem("magpieSendTimes", JSON.stringify([...sends, Date.now()]));
    } catch {}

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const done = (why) => { if (!settled) { settled = true; resolve(why); } };
      const remember = (value) => { if (value != null) events.push(value); };
      try {
        sendAttempted = true;
        client.streamPost("/f/conversation", {
          additionalHeaders: { "X-OpenAI-Attach-Desktop-Surface": "1" },
          body: JSON.stringify(body),
          chatgptSse: {},
          onResponse: remember,
          onEvent: remember,
          onStreamData: remember,
          onComplete: (value) => { remember(value); done("complete"); },
          onError: (value) => { streamError = value; remember(value); done("error"); },
          onPrematureTermination: () => done("premature"),
        });
      } catch (error) {
        streamError = error;
        done("error");
      }
    });

    const seen = new Set();
    let assistantSeen = false;
    const findId = (value) => {
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return null; }
      }
      if (value == null || typeof value !== "object" || seen.has(value)) return null;
      seen.add(value);
      if (value.author?.role === "assistant") assistantSeen = true;
      const direct = value.conversation_id ?? value.conversationId;
      if (typeof direct === "string" && direct) conversationId ??= direct;
      for (const [key, item] of Object.entries(value)) {
        if (!["content", "parts", "text"].includes(key)) findId(item);
      }
      return conversationId;
    };
    events.forEach(findId);

    // 串流開頭會帶 resume_conversation_token；App 靠它在串流中斷後打 /f/conversation/resume 接回同一則回答，
    // 沒有這張憑證續傳會回 404 tokenless_resume_unavailable（2026-10-21 實測）。
    let resumeToken = null;
    for (const rawEv of events) {
      let data = rawEv?.data ?? rawEv;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { continue; }
      }
      if (data?.type === "resume_conversation_token" && typeof data.token === "string") {
        resumeToken = data.token;
        break;
      }
    }

    // 只在結構化錯誤欄位遞迴；若外層已有非 model_cap_exceeded 的 code/type（如 rate_limit_exceeded），
    // 不得誤信內層 message 字串中的 model_cap_exceeded 而觸發重送。
    const errorSeen = new Set();
    const recognizedErrorCode = (value) => {
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return null; }
      }
      if (!value || typeof value !== "object" || errorSeen.has(value)) return null;
      errorSeen.add(value);
      const allowed = ["model_cap_exceeded", "usage_limit", "input_too_large", "message_length_exceeds_limit"];
      if (typeof value.code === "string") return allowed.includes(value.code) ? value.code : null;
      if (typeof value.errorCode === "string") return allowed.includes(value.errorCode) ? value.errorCode : null;
      if (typeof value.error_code === "string") return allowed.includes(value.error_code) ? value.error_code : null;
      if (typeof value.type === "string" && value.type !== "fetch-stream-error") {
        return allowed.includes(value.type) ? value.type : null;
      }
      for (const key of ["error", "detail", "data", "body", "message"]) {
        const code = recognizedErrorCode(value[key]);
        if (code) return code;
      }
      return null;
    };
    // 限流期伺服器仍會生完回答；先留原始錯誤與對話編號，才能判斷能否回頭撈答案。只記事件形狀，不存 prompt。
    if (outcome !== "complete") {
      const describe = (value) => {
        if (typeof value === "string") {
          try { value = JSON.parse(value); } catch { return "text:" + value.slice(0, 120); }
        }
        if (!value || typeof value !== "object") return typeof value;
        return [value.type, value.event, value.message?.author?.role, value.message?.status]
          .filter(Boolean).join("/") || Object.keys(value).slice(0, 6).join(",");
      };
      let errorText;
      try {
        errorText = JSON.stringify(streamError, Object.getOwnPropertyNames(streamError ?? {}));
      } catch {
        errorText = String(streamError);
      }
      const diag = {
        at: new Date().toISOString(),
        outcome,
        conversationId,
        assistantSeen,
        eventCount: events.length,
        eventShapes: events.slice(0, 40).map(describe),
        streamError: (errorText ?? "").slice(0, 4000),
        recoverWithinMs: options.recoverWithinMs ?? null,
        model: requestModel,
        hasResumeToken: resumeToken !== null,
      };
      if (resumeToken !== null && conversationId) {
        globalThis.__magpieLastResume = { conversationId, token: resumeToken, at: Date.now() };
      }
      globalThis.__magpieStreamDiag = [...(globalThis.__magpieStreamDiag ?? []), diag].slice(-20);
    }
    const errorCode = outcome === "error" ? recognizedErrorCode(streamError) : null;
    if (
      (errorCode === "input_too_large" || errorCode === "message_length_exceeds_limit") &&
      !conversationId &&
      !assistantSeen
    ) {
      return {
        error: "提示內容超過模型上下文或單一訊息長度上限（context_length_exceeded）",
        stage: "context_length_exceeded",
        errorCode,
        retrySafe: true,
        outcome,
      };
    }
    if (
      (errorCode === "usage_limit" && !assistantSeen) ||
      (errorCode === "model_cap_exceeded" && !conversationId && !assistantSeen)
    ) {
      let resetsAt = null;
      const limitedModels = {};
      const recordReset = (slug, rawIso) => {
        const parsed = Date.parse(rawIso ?? "");
        if (!Number.isFinite(parsed) || parsed <= Date.now()) return;
        const iso = new Date(parsed).toISOString();
        if (slug) limitedModels[slug] = iso;
        if (!resetsAt || parsed > Date.parse(resetsAt)) resetsAt = iso;
      };
      let errObj = streamError;
      if (typeof errObj === "string") {
        try { errObj = JSON.parse(errObj); } catch { errObj = null; }
      }
      recordReset(requestModel, errObj?.resets_after ?? errObj?.error?.resets_after ?? errObj?.detail?.resets_after);
      try {
        const init = await client.safePost("/conversation/init", {
          requestBody: {
            conversation_id: null,
            conversation_origin: null,
            gizmo_id: null,
            requested_default_model: requestModel,
            system_hints: null,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            timezone_offset_min: new Date().getTimezoneOffset(),
          },
        });
        for (const item of init?.model_limits ?? []) {
          if (typeof item?.model_slug === "string") {
            recordReset(item.model_slug, item.resets_after);
          }
        }
        const blockedFeature = (init?.blocked_features ?? []).find((f) => f?.name && f.name !== "send");
        recordReset(requestModel, blockedFeature?.resets_after ?? init?.banner_info?.resets_after);
      } catch {}
      if (resetsAt && !limitedModels[requestModel]) {
        limitedModels[requestModel] = resetsAt;
      }
      const retryAfterMs = resetsAt ? Math.max(1000, Date.parse(resetsAt) - Date.now()) : undefined;
      return {
        error: "模型配額明確拒絕本次請求",
        stage: "quota_exceeded",
        errorCode,
        quotaRejected: true,
        requestedModel: requestModel,
        ...(resetsAt ? { resetsAt, retryAfterMs } : {}),
        ...(Object.keys(limitedModels).length > 0 ? { limitedModels } : {}),
        retrySafe: true,
        outcome,
      };
    }
    // 依結構判斷而非錯誤文字：2026-10-20 實測直接拒收是 responseStatus 403、沒有任何串流事件也沒有對話；
    // 有對話編號的串流錯誤（responseStatus 200、failureOrigin server_stream）回答仍會在背景寫完。
    let errorObject = streamError;
    if (typeof errorObject === "string") {
      try { errorObject = JSON.parse(errorObject); } catch { errorObject = null; }
    }
    const rejectedBeforeConversation =
      outcome === "error" &&
      !conversationId &&
      !assistantSeen &&
      [403, 429].includes(errorObject?.responseStatus);
    if (rejectedBeforeConversation) {
      // 2026-10-21 實測 24 小時訊息上限是整個帳號的 send 被鎖，所有模型一起停、7 小時後才解；
      // 每 3 分鐘重試只會一直撞牆。App 自己用 /conversation/init 的 blocked_features 取得解鎖時間，照它冷卻。
      let until = Date.now() + 3 * 60 * 1000;
      if (errorObject?.responseStatus === 429) {
        try {
          const init = await client.safePost("/conversation/init", {
            requestBody: {
              conversation_id: null,
              conversation_origin: null,
              gizmo_id: null,
              requested_default_model: requestModel,
              system_hints: null,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              timezone_offset_min: new Date().getTimezoneOffset(),
            },
          });
          const send = (init?.blocked_features ?? []).find((feature) => feature?.name === "send");
          const resetsAt = Date.parse(send?.resets_after ?? "");
          if (Number.isFinite(resetsAt) && resetsAt > until) until = resetsAt;
        } catch {}
      }
      globalThis.__magpieUnusualActivityUntil = until;
      return {
        error: "ChatGPT Desktop 拒收請求（rate_limit_exceeded: HTTP " + errorObject.responseStatus + "），請稍後再試",
        stage: "rate_limited",
        accountCooldown: true,
        retrySafe: true,
        outcome,
        retryAfterMs: until - Date.now(),
      };
    }
    const recoverable = outcome !== "complete" && errorCode === null;
    if (!conversationId) {
      return {
        error: "串流沒有確認送出狀態",
        stage: "unknown_send_state",
        retrySafe: false,
        outcome,
      };
    }

    // 關閉 v1 delta 編碼後，/f/conversation 的 SSE 事件已直接攜帶 finished_successfully 的完稿 message；
    // 先從串流事件取答案可省去每回合結尾的 GET /conversation/{id}，避免高併發觸發讀取限流。
    // 同时剝除 GPT-6 model_dil_v2 對純 JSON/XML 外層包裹的 <escape>...</escape>。
    const unwrapDilEscape = (raw) => {
      const trimmed = String(raw ?? "").trim();
      if (trimmed.startsWith("<escape>") && trimmed.endsWith("</escape>")) {
        return trimmed.slice(8, -9).trim();
      }
      return trimmed;
    };
    let best = null;
    const considerMessage = (message) => {
      if (message?.author?.role !== "assistant") return;
      if (message?.status !== "finished_successfully") return;
      if (message?.recipient && message.recipient !== "all") return;
      if (message?.channel && message.channel !== "final") return;
      const content = message.content;
      const contentType = content?.content_type ?? content?.contentType;
      if (
        [
          "thought",
          "thoughts",
          "reasoning",
          "reasoning_recap",
          "model_editable_context",
          "code",
          "execution_output",
        ].includes(contentType)
      ) {
        return;
      }
      const rawText = Array.isArray(content?.parts)
        ? content.parts
            .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
            .join("")
            .trim()
        : typeof content?.text === "string"
          ? content.text.trim()
          : "";
      const text = unwrapDilEscape(rawText);
      if (!text) return;
      const at = message.create_time ?? 0;
      if (best === null || at >= best.at) {
        best = {
          at,
          text,
          model:
            message?.metadata?.model_slug ??
            message?.metadata?.resolved_model_slug ??
            null,
        };
      }
    };
    for (const rawEv of events) {
      let ev = rawEv;
      if (typeof ev === "string") {
        try { ev = JSON.parse(ev); } catch { ev = null; }
      }
      const msgCandidate =
        ev?.data?.message ?? ev?.data?.v?.message ?? ev?.message ?? null;
      if (msgCandidate) considerMessage(msgCandidate);
    }
    // 對話已建立但串流斷掉時，用對話編號讀回背景寫完的答案，不白丟這則回答。
    // 讀取額度整個帳號共用且很緊：2026-10-20 多筆並行撈答案時 GET 大半回 "Too many requests"，
    // 被拒的讀取似乎也延長限流，連 ChatGPT.app 自己的側欄都讀不到。所以同一時間只讓一筆撈，
    // 其餘直接放棄交給備援；讀取一被拒就停掉所有撈答案與送出 10 分鐘，讓額度恢復。
    let recoverReads = 0;
    const giveUp = (why, pauseMs, accountCooldown = pauseMs > 0) => {
      if (pauseMs > 0) {
        globalThis.__magpieReadBlockedUntil = Date.now() + pauseMs;
        globalThis.__magpieUnusualActivityUntil = Math.max(
          globalThis.__magpieUnusualActivityUntil ?? 0,
          Date.now() + pauseMs,
        );
      }
      return {
        error: "ChatGPT Desktop 串流中斷且" + why + "（rate_limit_exceeded），改用其他模型",
        stage: "rate_limited",
        accountCooldown,
        retrySafe: true,
        outcome,
        conversationId,
        recoverReads,
        // Retry-After 太短時 Magpie 會在同一請求內對同一個 provider 立刻重送（2026-10-21 實測 1 秒→連送 4 次、
        // 每次都是一則新生成），群組裡還會拖過 claude-mem 的 300 秒逾時；給 30 秒讓它改走下一個成員。
        retryAfterMs: Math.max(pauseMs, 30000),
      };
    };
    if (recoverable && best === null) {
      globalThis.__magpieSoftFlagAt = Date.now();
      if ((globalThis.__magpieReadBlockedUntil ?? 0) > Date.now()) return giveUp("讀取限流中", 0, true);
      // 同時撈答案的上限與讀取被拒後的暫停長度可在 renderer 直接調，方便實驗不用重新部署。
      // 預設 2：2026-10-21 模擬同時 2 筆 30 分鐘 44/45 成功、GET 0 次被拒；同時 3 筆 20 分鐘就撞到 24 小時上限。
      if ((globalThis.__magpieRecovering ?? 0) >= (globalThis.__magpieMaxRecovering ?? 2)) {
        return giveUp("撈答案名額已滿", 0, false);
      }
      globalThis.__magpieRecovering = (globalThis.__magpieRecovering ?? 0) + 1;
      // 整段對話的 GET 額度很緊（2026-10-20 實測約 6 分半 23 次就被限流），但 App 自己續傳前用的
      // stream_status 不算在內（2026-10-21 實測 5 分半連打 140 次都正常，之後 GET 也正常）。
      // 所以先輪詢 stream_status，等它不再是 IS_STREAMING 才讀整段對話，每撈一筆通常只花一次 GET。
      // 不能拿對話 update_time 判斷停住：thinking 寫正文期間它不會更新，曾把 197 秒寫完的回答在 184 秒誤判放棄。
      const statusGapMs = globalThis.__magpieStatusGapMs ?? 5000;
      const withTimeout = (promise, label) => Promise.race([
        promise,
        // safeGet 沒有自己的逾時；卡住一次就會把整段撈答案拖到呼叫端逾時。
        new Promise((_, reject) => setTimeout(() => reject(new Error(label + " timeout 20s")), 20000)),
      ]);
      const startedAt = Date.now();
      const deadline = startedAt + (options.recoverWithinMs ?? 90000);
      const readLog = [];
      let readRejected = false;
      let stalled = false;
      let statusPolls = 0;
      let statusErrors = 0;
      let lastStatus = null;
      let unreadable = false;
      // 只有 HTTP 429 才算讀取限流、要全體暫停；2026-10-21 長回答被插「something seems to have gone wrong」後
      // 讀對話回 404 conversation_inaccessible，被當成限流整個暫停 10 分鐘兩次，30 分鐘停擺 20 分鐘。
      const isThrottled = (error) => Number(error?.status ?? error?.responseStatus) === 429;
      try {
        while (best === null && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.min(statusGapMs, deadline - Date.now())));
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          let status;
          try {
            statusPolls += 1;
            status = (await withTimeout(
              client.safeGet("/conversation/" + encodeURIComponent(conversationId) + "/stream_status", {}),
              "status",
            ))?.status ?? null;
            statusErrors = 0;
          } catch (error) {
            statusErrors += 1;
            readLog.push({ s: elapsed, statusThrown: String(error?.message ?? error).slice(0, 200), httpStatus: error?.status ?? null });
            if (isThrottled(error) && statusErrors >= 3) { readRejected = true; break; }
            if (statusErrors >= 3) break;
            continue;
          }
          if (status !== lastStatus) readLog.push({ s: elapsed, status });
          lastStatus = status;
          if (status === "IS_STREAMING") continue;
          // 剛轉 COMPLETE 時正文偶爾還沒落進 mapping，隔一輪再讀一次，最多兩次 GET。
          for (let attempt = 0; attempt < 2 && best === null; attempt += 1) {
            if (attempt > 0) {
              const remainMs = deadline - Date.now();
              if (remainMs <= 0) break;
              await new Promise((r) => setTimeout(r, Math.min(statusGapMs, remainMs)));
            }
            recoverReads += 1;
            const entry = { s: Math.round((Date.now() - startedAt) / 1000), read: true };
            let conversation;
            try {
              conversation = await withTimeout(
                client.safeGet("/conversation/" + encodeURIComponent(conversationId), {}),
                "read",
              );
            } catch (error) {
              entry.thrown = String(error?.message ?? error).slice(0, 200);
              entry.httpStatus = error?.status ?? null;
              readLog.push(entry);
              if (isThrottled(error)) readRejected = true;
              else unreadable = true;
              break;
            }
            const nodes = Object.values(conversation?.mapping ?? {}).map((node) => node?.message).filter(Boolean);
            entry.assistant = nodes
              .filter((message) => message.author?.role === "assistant")
              .map((message) => [message.content?.content_type, message.status, message.channel ?? "-"].join("/"));
            for (const message of nodes) considerMessage(message);
            entry.found = best !== null;
            readLog.push(entry);
          }
          // 串流已結束卻沒有完稿：2026-10-21 實測 gpt-6-instant 長回答會停在 in_progress、stream_status 卻報 COMPLETE，
          // 之後再也不會寫完，不必再等。
          if (best === null && !readRejected && !unreadable) stalled = true;
          break;
        }
      } finally {
        globalThis.__magpieRecovering = Math.max(0, (globalThis.__magpieRecovering ?? 1) - 1);
        const mine = (globalThis.__magpieStreamDiag ?? []).find((d) => d.conversationId === conversationId);
        if (mine) {
          mine.reads = readLog.slice(-20);
          mine.statusPolls = statusPolls;
        }
      }
      if (best === null) {
        if (readRejected) return giveUp("讀取被拒", globalThis.__magpieReadPauseMs ?? 10 * 60 * 1000, true);
        if (unreadable) return giveUp("對話讀不到（這一筆放棄、不暫停）", 0, false);
        if (stalled) return giveUp("回答停在半截（串流狀態 " + lastStatus + "）", 0, false);
        return giveUp(Math.round((Date.now() - startedAt) / 1000) + " 秒內讀不到完成的回應", 0, false);
      }
    }
    if (!recoverable && (outcome !== "complete" || best === null)) {
      const conversation = await client.safeGet(
        \`/conversation/\${encodeURIComponent(conversationId)}\`,
        {},
      );
      const mapping = conversation?.mapping ?? {};
      best = null;
      for (const node of Object.values(mapping)) {
        considerMessage(node?.message);
      }
    }
    if (best === null) {
      return {
        error: "對話裡沒有完成的回應",
        stage: "unknown_send_state",
        retrySafe: false,
        outcome,
        conversationId,
      };
    }
    return {
      answer: best.text,
      model: best.model,
      requestedModel: requestModel,
      conversationId,
      outcome: recoverable ? "recovered" : outcome,
      recoverReads,
      eventCount: events.length,
      clientExport: resolved.exportName,
    };
  } catch (error) {
    const msg = String(error?.message ?? error).trim();
    return {
      error: msg.length > 0 ? msg : "renderer 執行失敗",
      stage: sendAttempted ? "unknown_send_state" : "unknown",
      retrySafe: !sendAttempted,
      conversationId,
    };
  }
})()`;
};

const NON_TEXT_KEYS = [
  "image_url",
  "input_audio",
  "audio",
  "image",
  "file",
  "video",
];

const extractMessageText = (msg) => {
  if (!msg || typeof msg !== "object") {
    throw new ChatGPTDesktopError("無效的訊息格式", {
      stage: "unsupported_input",
      retrySafe: true,
      status: 400,
    });
  }
  if (msg.role === "tool" || msg.role === "function") {
    throw new ChatGPTDesktopError("不支援工具或函式角色訊息", {
      stage: "unsupported_input",
      retrySafe: true,
      status: 400,
    });
  }
  if (
    (Array.isArray(msg.attachments) && msg.attachments.length > 0) ||
    (Array.isArray(msg.files) && msg.files.length > 0) ||
    (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
    msg.function_call != null
  ) {
    throw new ChatGPTDesktopError("不支援圖片、音訊或非文字附件輸入", {
      stage: "unsupported_input",
      retrySafe: true,
      status: 400,
    });
  }
  for (const key of NON_TEXT_KEYS) {
    if (msg[key] != null) {
      throw new ChatGPTDesktopError("不支援圖片、音訊或非文字附件輸入", {
        stage: "unsupported_input",
        retrySafe: true,
        status: 400,
      });
    }
  }

  const content = msg.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const chunks = [];
    for (const part of content) {
      if (typeof part === "string") {
        chunks.push(part);
        continue;
      }
      if (!part || typeof part !== "object") {
        throw new ChatGPTDesktopError("不支援的非文字內容結構", {
          stage: "unsupported_input",
          retrySafe: true,
          status: 400,
        });
      }
      for (const key of NON_TEXT_KEYS) {
        if (part[key] != null) {
          throw new ChatGPTDesktopError("不支援圖片、音訊或非文字附件輸入", {
            stage: "unsupported_input",
            retrySafe: true,
            status: 400,
          });
        }
      }
      const partType = part.type ?? "text";
      if (!["text", "input_text", "output_text"].includes(partType)) {
        throw new ChatGPTDesktopError(`不支援的非文字內容類型：${partType}`, {
          stage: "unsupported_input",
          retrySafe: true,
          status: 400,
        });
      }
      if (typeof part.text !== "string") {
        throw new ChatGPTDesktopError("文字段落缺少 text 字串欄位", {
          stage: "unsupported_input",
          retrySafe: true,
          status: 400,
        });
      }
      chunks.push(part.text);
    }
    return chunks.join("").trim();
  }
  throw new ChatGPTDesktopError("不支援的訊息內容格式", {
    stage: "unsupported_input",
    retrySafe: true,
    status: 400,
  });
};

const roleLabel = (role) => {
  switch (role) {
    case "system":
    case "developer":
      return "System";
    case "assistant":
      return "Assistant";
    case "user":
      return "User";
    default:
      return String(role ?? "User");
  }
};

export const formatMessagesToPrompt = (messagesOrPrompt) => {
  const enforceByteCap = (formatted) => {
    if (Buffer.byteLength(formatted, "utf8") > MAX_PROMPT_BYTES) {
      throw new ChatGPTDesktopError(
        `提示內容超過 ChatGPT Desktop 單次訊息上限（${MAX_PROMPT_BYTES} bytes, context_length_exceeded）`,
        {
          stage: "context_length_exceeded",
          retrySafe: true,
          status: 413,
        },
      );
    }
    return formatted;
  };

  if (typeof messagesOrPrompt === "string") {
    const trimmed = messagesOrPrompt.trim();
    if (!trimmed) {
      throw new ChatGPTDesktopError("提示內容不可為空", {
        stage: "unsupported_input",
        retrySafe: true,
        status: 400,
      });
    }
    return enforceByteCap(trimmed);
  }

  if (!Array.isArray(messagesOrPrompt) || messagesOrPrompt.length === 0) {
    throw new ChatGPTDesktopError("messages 不可為空", {
      stage: "unsupported_input",
      retrySafe: true,
      status: 400,
    });
  }

  const normalized = messagesOrPrompt.map((msg) => ({
    role: msg?.role ?? "user",
    text: extractMessageText(msg),
  }));

  const nonEmpty = normalized.filter((item) => item.text.length > 0);
  if (nonEmpty.length === 0) {
    throw new ChatGPTDesktopError("提示內容不可為空", {
      stage: "unsupported_input",
      retrySafe: true,
      status: 400,
    });
  }

  if (nonEmpty.length === 1 && nonEmpty[0].role === "user") {
    return enforceByteCap(nonEmpty[0].text);
  }

  return enforceByteCap(
    nonEmpty
      .map((item) => `[${roleLabel(item.role)}]\n${item.text}`)
      .join("\n\n"),
  );
};

const attachWsListener = (ws, event, handler) => {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, handler);
  } else if (typeof ws.on === "function") {
    ws.on(event, handler);
  } else {
    ws[`on${event}`] = handler;
  }
};

const safeCloseWs = (ws) => {
  try {
    if (ws && typeof ws.close === "function") {
      ws.close();
    }
  } catch {
    // 關閉失敗不覆蓋原始錯誤。
  }
};

export const evaluateInRenderer = ({
  wsUrl,
  expression,
  timeoutMs = 30000,
  signal,
  generation = false,
  WebSocketImpl = WebSocket,
} = {}) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let wsOpened = false;
    let ws = null;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      safeCloseWs(ws);
      reject(error);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      safeCloseWs(ws);
      resolve(value);
    };

    function onAbort() {
      fail(
        new ChatGPTDesktopError("請求已取消", {
          stage: generation ? "unknown_send_state" : "aborted",
          retrySafe: !generation,
          status: 502,
          details: { aborted: true },
        }),
      );
    }

    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (error) {
      fail(
        new ChatGPTDesktopError(`CDP 連線中斷：${error?.message ?? error}`, {
          stage: generation ? "unknown_send_state" : "cdp_unreachable",
          retrySafe: !generation,
          status: 502,
          cause: error,
        }),
      );
      return;
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      fail(
        new ChatGPTDesktopError(`renderer ${seconds} 秒內沒有回應`, {
          stage: generation
            ? "unknown_send_state"
            : wsOpened
              ? "renderer_timeout"
              : "cdp_unreachable",
          retrySafe: !generation,
          status: 502,
          details: { timeoutMs, wsOpened },
        }),
      );
    }, timeoutMs);

    attachWsListener(ws, "open", () => {
      if (settled) return;
      wsOpened = true;
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression,
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        );
      } catch (error) {
        fail(
          new ChatGPTDesktopError(`CDP 連線中斷：${error?.message ?? error}`, {
            stage: generation ? "unknown_send_state" : "cdp_unreachable",
            retrySafe: !generation,
            status: 502,
            cause: error,
          }),
        );
      }
    });

    attachWsListener(ws, "message", (event) => {
      if (settled) return;
      const raw =
        typeof event === "string" || Buffer.isBuffer(event)
          ? String(event)
          : String(event?.data ?? "");
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        fail(
          new ChatGPTDesktopError(
            `無法確認 renderer 回應：${error?.message ?? error}`,
            {
              stage: generation ? "unknown_send_state" : "cdp_unreachable",
              retrySafe: !generation,
              status: 502,
              cause: error,
            },
          ),
        );
        return;
      }

      if (message?.id !== 1) return;

      if (message.error) {
        fail(
          new ChatGPTDesktopError(message.error.message ?? "CDP 回報錯誤", {
            stage: generation ? "unknown_send_state" : "cdp_unreachable",
            retrySafe: !generation,
            status: 502,
          }),
        );
        return;
      }

      const evalResult = message.result ?? {};
      if (evalResult.exceptionDetails) {
        fail(
          new ChatGPTDesktopError(
            evalResult.exceptionDetails.text ?? "renderer 執行失敗",
            {
              stage: generation ? "unknown_send_state" : "cdp_unreachable",
              retrySafe: !generation,
              status: 502,
            },
          ),
        );
        return;
      }

      const value = evalResult.result?.value;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(
          new ChatGPTDesktopError("renderer 回傳了非預期的結果", {
            stage: generation ? "unknown_send_state" : "cdp_unreachable",
            retrySafe: !generation,
            status: 502,
          }),
        );
        return;
      }

      if (
        (value.error !== undefined && value.error !== null) ||
        value.retrySafe === false ||
        value.stage === "unknown_send_state" ||
        (generation &&
          (typeof value.answer !== "string" || value.answer.trim().length === 0))
      ) {
        const retrySafe = generation
          ? value.retrySafe === true
          : value.retrySafe !== false;
        const stage =
          value.stage ??
          (value.quotaRejected
            ? "quota_exceeded"
            : retrySafe
              ? "client_not_found"
              : "unknown_send_state");
        const status =
          value.quotaRejected || stage === "rate_limited"
            ? 429
            : stage === "context_length_exceeded"
              ? 413
              : 502;
        const rawErr =
          typeof value.error === "string" ? value.error.trim() : "";
        fail(
          new ChatGPTDesktopError(
            rawErr.length > 0 ? rawErr : "renderer 執行失敗",
            {
              stage,
              retrySafe,
              status,
              details: value,
            },
          ),
        );
        return;
      }

      succeed(value);
    });

    attachWsListener(ws, "error", (event) => {
      if (settled) return;
      const reason = event?.message ?? event?.error?.message ?? "socket error";
      fail(
        new ChatGPTDesktopError(`CDP 連線中斷：${reason}`, {
          stage: generation ? "unknown_send_state" : "cdp_unreachable",
          retrySafe: !generation,
          status: 502,
        }),
      );
    });

    attachWsListener(ws, "close", () => {
      if (settled) return;
      fail(
        new ChatGPTDesktopError("CDP 連線中斷：WebSocket 已關閉", {
          stage: generation ? "unknown_send_state" : "cdp_unreachable",
          retrySafe: !generation,
          status: 502,
        }),
      );
    });
  });

export const normalizeCatalogModels = (catalog) => {
  const rawModels = Array.isArray(catalog?.models) ? catalog.models : [];
  const seen = new Set();
  const normalized = [];
  for (const item of rawModels) {
    const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const entry = {
      id: slug,
      slug,
      name: item.title ?? item.name ?? slug,
      description: item.description ?? "",
      tool_call: false,
      is_work_mode_model: Boolean(item.is_work_mode_model),
      input_modalities: ["text"],
      output_modalities: ["text"],
    };
    if (typeof item?.max_tokens === "number" && item.max_tokens > 0) {
      entry.context_window = item.max_tokens;
    }
    if (item.reasoning !== undefined || Array.isArray(item.thinking_efforts)) {
      entry.reasoning = Boolean(
        item.reasoning ?? item.thinking_efforts?.length,
      );
    }
    normalized.push(entry);
  }
  return normalized;
};

const inFlightProbes = new Map();
const inFlightModels = new Map();

export const probeClient = async ({
  cdpUrl,
  configuredPort,
  env = process.env,
  runningProcessArgs,
  detectRunningPort,
  fetchImpl,
  WebSocketImpl,
  timeoutMs = 30000,
  targetTimeoutMs = 4000,
  signal,
} = {}) => {
  const resolvedCdp = cdpUrl
    ? { cdpUrl }
    : await resolveCdpPort({
        configuredPort,
        env,
        runningProcessArgs,
        detectRunningPort,
        forLaunch: false,
      });
  const preferred = preferredClientExports(env);
  const canDedupe = !signal && !fetchImpl && !WebSocketImpl;
  const dedupeKey = `${resolvedCdp.cdpUrl}|${preferred.join(",")}`;
  if (canDedupe && inFlightProbes.has(dedupeKey)) {
    const shared = await inFlightProbes.get(dedupeKey);
    return structuredClone(shared);
  }
  const run = (async () => {
    const target = await getRendererTarget({
      cdpUrl: resolvedCdp.cdpUrl,
      fetchImpl,
      timeoutMs: targetTimeoutMs,
    });
    const result = await evaluateInRenderer({
      wsUrl: target.webSocketDebuggerUrl,
      expression: buildProbeExpression(preferred),
      timeoutMs,
      signal,
      generation: false,
      WebSocketImpl,
    });
    return {
      ...result,
      ok: true,
      preferred,
      drifted: result.clientExport !== preferred[0],
    };
  })();
  if (!canDedupe) {
    return run;
  }
  inFlightProbes.set(dedupeKey, run);
  try {
    const out = await run;
    return structuredClone(out);
  } finally {
    inFlightProbes.delete(dedupeKey);
  }
};

export const listModels = async ({
  cdpUrl,
  configuredPort,
  env = process.env,
  runningProcessArgs,
  detectRunningPort,
  fetchImpl,
  WebSocketImpl,
  timeoutMs = 30000,
  targetTimeoutMs = 4000,
  signal,
} = {}) => {
  const resolvedCdp = cdpUrl
    ? { cdpUrl }
    : await resolveCdpPort({
        configuredPort,
        env,
        runningProcessArgs,
        detectRunningPort,
        forLaunch: false,
      });
  const preferred = preferredClientExports(env);
  const canDedupe = !signal && !fetchImpl && !WebSocketImpl;
  const dedupeKey = `${resolvedCdp.cdpUrl}|${preferred.join(",")}`;
  if (canDedupe && inFlightModels.has(dedupeKey)) {
    const shared = await inFlightModels.get(dedupeKey);
    return structuredClone(shared);
  }
  const run = (async () => {
    const target = await getRendererTarget({
      cdpUrl: resolvedCdp.cdpUrl,
      fetchImpl,
      timeoutMs: targetTimeoutMs,
    });
    const result = await evaluateInRenderer({
      wsUrl: target.webSocketDebuggerUrl,
      expression: buildModelsExpression(preferred),
      timeoutMs,
      signal,
      generation: false,
      WebSocketImpl,
    });
    return {
      models: normalizeCatalogModels(result.catalog),
      catalog: result.catalog ?? { models: [], versions: [] },
      clientExport: result.clientExport ?? null,
      moduleUrl: result.moduleUrl ?? null,
    };
  })();
  if (!canDedupe) {
    return run;
  }
  inFlightModels.set(dedupeKey, run);
  try {
    const out = await run;
    return structuredClone(out);
  } finally {
    inFlightModels.delete(dedupeKey);
  }
};

export const sendConversation = async ({
  prompt,
  messages,
  model,
  effort = "standard",
  instantFallback = false,
  allowProFallback = true,
  onFallbackStart,
  onFallbackComplete,
  onFallbackFailed,
  cdpUrl,
  configuredPort,
  env = process.env,
  runningProcessArgs,
  detectRunningPort,
  fetchImpl,
  WebSocketImpl,
  timeoutMs = 420000,
  targetTimeoutMs = 4000,
  dailyBudget = null,
  signal,
} = {}) => {
  const selectedModel = typeof model === "string" ? model.trim() : "";
  if (!selectedModel) {
    throw new ChatGPTDesktopError("未指定模型", {
      stage: "unsupported_input",
      retrySafe: true,
      status: 400,
    });
  }

  // 送出前先驗證與折疊訊息；若含圖片、音訊或非文字附件，直接拋出 400 且不發起任何遠端連線。
  const formattedPrompt = formatMessagesToPrompt(messages ?? prompt);

  if (Date.now() < unusualActivityUntil) {
    throw new ChatGPTDesktopError(
      "ChatGPT Desktop 送出間隔冷卻中（rate_limit_exceeded），請稍後再試",
      {
        stage: "rate_limited",
        retrySafe: true,
        status: 429,
        details: { retryAfterMs: unusualActivityUntil - Date.now() },
      },
    );
  }

  const resolvedCdp = cdpUrl
    ? { cdpUrl }
    : await resolveCdpPort({
        configuredPort,
        env,
        runningProcessArgs,
        detectRunningPort,
        forLaunch: false,
      });
  const preferred = preferredClientExports(env);

  const sendOnce = async (useInstantFallback) => {
    const target = await getRendererTarget({
      cdpUrl: resolvedCdp.cdpUrl,
      fetchImpl,
      timeoutMs: targetTimeoutMs,
    });
    const expression = buildChatExpression(
      {
        prompt: formattedPrompt,
        model: selectedModel,
        effort,
        instantFallback: useInstantFallback,
        // 背景群組的答案常要 60～150 秒才寫完（2026-10-20 實測 90 秒截掉多筆 in_progress），預設 210 秒；
        // 仍留時間給撈不到時 Magpie 換備援，不讓整段先撞 claude-mem 的 300 秒。
        recoverWithinMs: Math.max(0, Math.min(210000, timeoutMs - 120000)),
        dailyBudget,
      },
      preferred,
    );
    return evaluateInRenderer({
      wsUrl: target.webSocketDebuggerUrl,
      expression,
      timeoutMs,
      signal,
      generation: true,
      WebSocketImpl,
    });
  };

  let fallbackId = null;
  let result;
  try {
    result = await sendOnce(false);
  } catch (error) {
    // 只有真正全帳號限流（被拒收或讀取 429）才記進程序冷卻；單筆卡住、讀不到或自家每日預算不冷凍整個帳號。
    if (error?.stage === "rate_limited" && error?.details?.accountCooldown === true) {
      unusualActivityUntil = Date.now() + (error?.details?.retryAfterMs ?? UNUSUAL_ACTIVITY_COOLDOWN_MS);
    }
    const details = error?.details ?? {};
    const eligibleModel = allowProFallback
      ? true
      : selectedModel.endsWith("-thinking");
    const canFallback =
      Boolean(instantFallback) &&
      eligibleModel &&
      error instanceof ChatGPTDesktopError &&
      error.retrySafe === true &&
      details.quotaRejected === true &&
      ["model_cap_exceeded", "usage_limit"].includes(details.errorCode) &&
      details.requestedModel === selectedModel;

    if (!canFallback) {
      throw error;
    }

    fallbackId = crypto.randomUUID();
    if (typeof onFallbackStart === "function") {
      await onFallbackStart({
        fallbackId,
        requestedModel: selectedModel,
        reasonCode: "model_cap_exceeded",
        fallbackMode: "Instant",
      });
    }

    try {
      result = await sendOnce(true);
    } catch (fallbackError) {
      if (typeof onFallbackFailed === "function") {
        await onFallbackFailed({
          fallbackId,
          requestedModel: selectedModel,
          error: fallbackError,
        });
      }
      throw fallbackError;
    }

    if (typeof onFallbackComplete === "function") {
      await onFallbackComplete({
        fallbackId,
        requestedModel: selectedModel,
        result,
      });
    }
  }

  const requestedModel = result.requestedModel ?? selectedModel;
  const promptTokens = estimateTokenCount(formattedPrompt);
  const completionTokens = estimateTokenCount(result.answer);
  return {
    answer: result.answer,
    model: result.model ?? requestedModel,
    requestedModel,
    conversationId: result.conversationId ?? null,
    outcome: result.outcome,
    recoverReads: result.recoverReads ?? 0,
    eventCount: result.eventCount ?? 0,
    clientExport: result.clientExport ?? null,
    fallbackUsed: fallbackId !== null,
    fallbackId,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
};

export const recordFallbackLog = (
  event,
  fallbackId,
  requestedModel,
  metadata = {},
  { env = process.env, logPath } = {},
) => {
  const resolvedPath =
    logPath ??
    env?.SIDECAR_WEB_FALLBACK_LOG ??
    path.join(os.homedir(), ".cache", "sidecar-webchat-fallback.jsonl");
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_APPEND |
    fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK;
  const fd = fs.openSync(resolvedPath, flags, 0o600);
  try {
    const info = fs.fstatSync(fd);
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : info.uid;
    if (!info.isFile() || info.nlink !== 1 || info.uid !== currentUid) {
      throw new Error("降級紀錄必須是本人持有、沒有連結的普通檔案");
    }
    fs.fchmodSync(fd, 0o600);
    const entry = {
      event,
      at: new Date().toISOString(),
      fallback_id: fallbackId,
      requested_model: requestedModel,
      ...metadata,
    };
    const buffer = Buffer.from(JSON.stringify(entry) + "\n", "utf8");
    const written = fs.writeSync(fd, buffer, 0, buffer.length);
    if (written !== buffer.length) {
      throw new Error("降級紀錄未完整寫入");
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

export const finishFallbackLog = (
  event,
  fallbackId,
  requestedModel,
  metadata = {},
  {
    env = process.env,
    logPath,
    writeStderr = (line) => process.stderr.write(line),
  } = {},
) => {
  // 答案可能已收到；紀錄失敗不能讓外層把同一請求再送一次。
  try {
    recordFallbackLog(event, fallbackId, requestedModel, metadata, {
      env,
      logPath,
    });
  } catch (error) {
    writeStderr(`Instant 降級結果未能寫入紀錄：${error?.message ?? error}\n`);
  }
};
