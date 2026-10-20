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
    const cacheKey = \`\${primaryUrl}|\${preferredClientExports.join(",")}\`;
    const cached = globalThis.__magpieAttestedCache;
    if (
      cached &&
      cached.cacheKey === cacheKey &&
      cached.expiresAt > Date.now() &&
      cached.resolved?.client
    ) {
      return cached.resolved;
    }
    const attestationProbe = (candidate) =>
      candidate.safeGet("/ios/attestation_challenge", {
        additionalHeaders: { "X-OpenAI-Attach-DeviceCheck-Token": "1" },
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
    const out = { ...resolved, moduleUrl };
    const expireAfterSec = Number(resolved.probeValue?.expire_after ?? 0);
    if (Number.isFinite(expireAfterSec) && expireAfterSec > 60) {
      globalThis.__magpieAttestedCache = {
        cacheKey,
        expiresAt: Date.now() + Math.min(expireAfterSec - 60, 480) * 1000,
        resolved: out,
      };
    }
    return out;
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

    // 被標記期間，兩筆 POST 間隔太近（實測 6～41 秒）就會被 403 直接拒收；
    // 檢查與登記之間沒有 await，同時進來的請求不會一起通過。
    const blocked = coolingDown();
    if (blocked) return blocked;
    const postedAt = Date.now();
    const minPostGapMs = options.minPostGapMs ?? 60000;
    const flaggedRecently = postedAt - (globalThis.__magpieFlaggedAt ?? 0) < 60 * 60 * 1000;
    if (flaggedRecently) globalThis.__magpieUnusualActivityUntil = postedAt + minPostGapMs;

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const done = (why) => { if (!settled) { settled = true; resolve(why); } };
      const remember = (value) => { if (value != null) events.push(value); };
      try {
        sendAttempted = true;
        client.streamPost("/f/conversation", {
          additionalHeaders: {},
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

    // 只在結構化錯誤欄位遞迴；若外層已有非 model_cap_exceeded 的 code/type（如 rate_limit_exceeded），
    // 不得誤信內層 message 字串中的 model_cap_exceeded 而觸發重送。
    const errorSeen = new Set();
    const recognizedErrorCode = (value) => {
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return null; }
      }
      if (!value || typeof value !== "object" || errorSeen.has(value)) return null;
      errorSeen.add(value);
      const allowed = ["model_cap_exceeded", "input_too_large", "message_length_exceeds_limit"];
      if (typeof value.code === "string") return allowed.includes(value.code) ? value.code : null;
      if (typeof value. errorCode === "string") return allowed.includes(value.errorCode) ? value.errorCode : null;
      if (typeof value.type === "string") return allowed.includes(value.type) ? value.type : null;
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
      };
      globalThis.__magpieStreamDiag = [...(globalThis.__magpieStreamDiag ?? []), diag].slice(-5);
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
    if (errorCode === "model_cap_exceeded" && !conversationId && !assistantSeen) {
      return {
        error: "模型配額明確拒絕本次請求",
        stage: "quota_exceeded",
        errorCode,
        quotaRejected: true,
        requestedModel: requestModel,
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
      globalThis.__magpieAttestedCache = null;
      globalThis.__magpieFlaggedAt = Date.now();
      globalThis.__magpieUnusualActivityUntil = Date.now() + 3 * 60 * 1000;
      return {
        error: "ChatGPT Desktop 拒收請求（rate_limit_exceeded: HTTP " + errorObject.responseStatus + "），請稍後再試",
        stage: "rate_limited",
        retrySafe: true,
        outcome,
        retryAfterMs: 3 * 60 * 1000,
      };
    }
    const recoverable = outcome !== "complete" && errorCode === null;
    if (recoverable && conversationId) {
      globalThis.__magpieFlaggedAt = Date.now();
      globalThis.__magpieUnusualActivityUntil = Math.max(
        globalThis.__magpieUnusualActivityUntil ?? 0,
        postedAt + minPostGapMs,
      );
    }
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
    // 對話已建立但串流斷掉時，用對話編號讀回背景寫完的答案，不白丟這則回答。
    // 漸長間隔是為了壓低讀取次數，避免讀取本身再被判成異常流量。
    let recoverReads = 0;
    if (recoverable) {
      const waits = [3000, 5000, 10000, 15000, 20000, 30000];
      const startedAt = Date.now();
      const deadline = startedAt + (options.recoverWithinMs ?? 300000);
      const readLog = [];
      while (best === null && Date.now() < deadline) {
        const wait = Math.min(waits[Math.min(recoverReads, waits.length - 1)], deadline - Date.now());
        await new Promise((r) => setTimeout(r, wait));
        recoverReads += 1;
        const entry = { s: Math.round((Date.now() - startedAt) / 1000) };
        let conversation;
        try {
          conversation = await client.safeGet("/conversation/" + encodeURIComponent(conversationId), {});
        } catch (error) {
          entry.thrown = String(error?.message ?? error).slice(0, 200);
          readLog.push(entry);
          continue;
        }
        const nodes = Object.values(conversation?.mapping ?? {}).map((node) => node?.message).filter(Boolean);
        entry.nodes = nodes.length;
        if (nodes.length === 0) entry.raw = JSON.stringify(conversation ?? null).slice(0, 200);
        entry.assistant = nodes
          .filter((message) => message.author?.role === "assistant")
          .map((message) => [message.content?.content_type, message.status, message.channel ?? "-"].join("/"));
        for (const message of nodes) considerMessage(message);
        entry.found = best !== null;
        readLog.push(entry);
      }
      const last = (globalThis.__magpieStreamDiag ?? []).at(-1);
      if (last?.conversationId === conversationId) last.reads = readLog.slice(-20);
      if (best === null) {
        return {
          error: "串流中斷後 " + Math.round((Date.now() - startedAt) / 1000) + " 秒內讀不到完成的回應",
          stage: "unknown_send_state",
          retrySafe: false,
          outcome,
          conversationId,
          recoverReads,
        };
      }
    }
    if (outcome === "complete") {
      for (const rawEv of events) {
        let ev = rawEv;
        if (typeof ev === "string") {
          try { ev = JSON.parse(ev); } catch { ev = null; }
        }
        const msgCandidate =
          ev?.data?.message ?? ev?.data?.v?.message ?? ev?.message ?? null;
        if (msgCandidate) considerMessage(msgCandidate);
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
        // 留 2 分鐘給撈不到答案時 Magpie 換備援，不讓整段先撞外層逾時。
        recoverWithinMs: Math.max(0, Math.min(300000, timeoutMs - 120000)),
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
    if (error?.stage === "rate_limited") {
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
      details.errorCode === "model_cap_exceeded" &&
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
