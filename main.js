/**
 * Session Notify — send session title + turn status to Feishu / DingTalk /
 * WeCom / KOOK / Server酱 / Telegram / webhook / custom API. Message text is never sent.
 */

const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const crypto = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const POLL_MS = 1500;
const LOG_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 10000;
const COMMAND_ID = "notify.open";
const SERVICE_ID = "poll";
const CHANNEL_TYPES = [
  "feishu",
  "dingtalk",
  "wecom",
  "kook",
  "serverchan",
  "telegram",
  "webhook",
  "api",
];

const EVENT_KEYS = [
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "failed",
  "interrupted",
];

const DEFAULT_EVENTS = {
  running: false,
  waiting_input: true,
  waiting_approval: true,
  completed: true,
  failed: true,
  interrupted: false,
};

const DEFAULT_BODY =
  '{"title":"{{title}}","status":"{{status}}","statusLabel":"{{statusLabel}}","sessionId":"{{sessionId}}","at":"{{at}}"}';

const CHANNEL_NAMES = {
  "zh-CN": {
    feishu: "飞书",
    dingtalk: "钉钉",
    wecom: "企业微信",
    kook: "KOOK",
    serverchan: "Server酱",
    telegram: "Telegram",
    webhook: "通用 Webhook",
    api: "自定义 API",
  },
  en: {
    feishu: "Feishu",
    dingtalk: "DingTalk",
    wecom: "WeCom",
    kook: "KOOK",
    serverchan: "ServerChan",
    telegram: "Telegram",
    webhook: "Generic webhook",
    api: "Custom API",
  },
};

const LABELS = {
  "zh-CN": {
    running: "正在回复",
    waiting_input: "等待输入",
    waiting_approval: "等待批准",
    completed: "结束",
    failed: "出错",
    interrupted: "被停止",
    untitled: "未命名会话",
  },
  en: {
    running: "Running",
    waiting_input: "Waiting for input",
    waiting_approval: "Waiting for approval",
    completed: "Completed",
    failed: "Failed",
    interrupted: "Stopped",
    untitled: "Untitled session",
  },
};

let pollTimer = null;
let polling = false;
let snapshot = new Map();
let snapshotReady = false;
let logEntries = [];
let stateFile = "";
let locale = "zh-CN";
let pluginConfig = {
  channels: [],
  proxy: { mode: "auto", url: "" },
  notifyWhenFocused: true,
};

function hostRootFromDataPath(dataPath) {
  return path.resolve(String(dataPath || ""), "..", "..", "..");
}

function openHostDb(dbFile) {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return null;
  }
  if (!sqlite?.DatabaseSync) return null;
  try {
    return new sqlite.DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return null;
  }
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

function shortId(id) {
  const text = String(id || "");
  return text.length <= 8 ? text : text.slice(0, 8);
}

function isZh() {
  return locale === "zh-CN";
}

function labels() {
  return LABELS[isZh() ? "zh-CN" : "en"];
}

function channelNames() {
  return CHANNEL_NAMES[isZh() ? "zh-CN" : "en"];
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeEvent(status) {
  const raw = String(status || "").toLowerCase();
  if (raw === "running" || raw === "queued" || raw === "pending") return "running";
  if (raw === "waiting_input") return "waiting_input";
  if (raw === "waiting_approval") return "waiting_approval";
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  if (raw === "interrupted" || raw === "canceled" || raw === "cancelled") return "interrupted";
  return "";
}

function defaultEvents() {
  return { ...DEFAULT_EVENTS };
}

function parseEvents(value) {
  const base = defaultEvents();
  if (!value || typeof value !== "object") return base;
  for (const key of EVENT_KEYS) {
    if (typeof value[key] === "boolean") base[key] = value[key];
  }
  return base;
}

function defaultChannel(type) {
  const kind = CHANNEL_TYPES.includes(type) ? type : "webhook";
  return {
    id: newId(),
    type: kind,
    enabled: true,
    name: CHANNEL_NAMES["zh-CN"][kind],
    url: "",
    secret: "",
    sendKey: "",
    botToken: "",
    chatId: "",
    method: "POST",
    headers: "",
    bodyTemplate: kind === "api" ? DEFAULT_BODY : "",
    useProxy: false,
    events: defaultEvents(),
  };
}

function normalizeChannel(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const type = CHANNEL_TYPES.includes(src.type) ? src.type : src.url ? "api" : "webhook";
  const base = defaultChannel(type);
  const method = String(src.method || "POST").toUpperCase();
  return {
    id: String(src.id || base.id),
    type,
    enabled: src.enabled !== false,
    name: String(src.name || base.name).trim() || base.name,
    url: String(src.url || "").trim(),
    secret: String(src.secret || ""),
    sendKey: String(src.sendKey || (type === "serverchan" ? src.secret : "") || "").trim(),
    botToken: String(src.botToken || (type === "telegram" ? src.secret : "") || "").trim(),
    chatId: String(src.chatId || (type === "telegram" ? src.sendKey || src.url : "") || "").trim(),
    method: ["GET", "POST", "PUT"].includes(method) ? method : "POST",
    headers: String(src.headers || ""),
    bodyTemplate: String(src.bodyTemplate || (type === "api" ? DEFAULT_BODY : "")),
    useProxy: src.useProxy === true,
    events: parseEvents(src.events),
  };
}

function normalizeProxy(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    mode: src.mode === "manual" ? "manual" : "auto",
    url: String(src.url || "").trim(),
  };
}

function migrateChannels(src) {
  if (Array.isArray(src.channels)) {
    return src.channels.map((ch) =>
      normalizeChannel({
        ...ch,
        events: ch.events || src.events,
      }),
    );
  }
  if (src.url) {
    return [
      normalizeChannel({
        type: "api",
        enabled: src.enabled !== false,
        name: CHANNEL_NAMES["zh-CN"].api,
        url: src.url,
        method: src.method,
        headers: src.headers,
        bodyTemplate: src.bodyTemplate,
        events: src.events,
      }),
    ];
  }
  return [];
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    channels: migrateChannels(src),
    proxy: normalizeProxy(src.proxy),
    notifyWhenFocused: src.notifyWhenFocused !== false,
  };
}

function readConfig() {
  return normalizeConfig(pluginConfig);
}

function loadState() {
  if (!stateFile || !existsSync(stateFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    snapshot = new Map(Object.entries(parsed.snapshot || {}));
    snapshotReady = snapshot.size > 0;
    if (parsed.config) pluginConfig = normalizeConfig(parsed.config);
  } catch {
    /* ignore */
  }
}

function saveState() {
  if (!stateFile) return;
  try {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({
        config: pluginConfig,
        snapshot: Object.fromEntries(snapshot),
      }),
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

function jsonEscape(value) {
  return JSON.stringify(String(value ?? "")).slice(1, -1);
}

function pushLog(entry) {
  logEntries.unshift(entry);
  if (logEntries.length > LOG_LIMIT) logEntries.length = LOG_LIMIT;
}

function parseHeaderText(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (key) out[String(key)] = String(value ?? "");
        }
        return out;
      }
    } catch {
      /* fall through */
    }
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const cut = line.indexOf(":");
    if (cut <= 0) continue;
    const key = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function applyTemplate(template, fields, mode) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = fields[key] == null ? "" : String(fields[key]);
    if (mode === "json") return jsonEscape(value);
    if (mode === "url") return encodeURIComponent(value);
    return value;
  });
}
function payloadFields(session, eventKey) {
  const pack = labels();
  return {
    title: session.title || pack.untitled,
    status: eventKey,
    statusLabel: pack[eventKey] || eventKey,
    sessionId: shortId(session.id),
    shortId: shortId(session.id),
    at: new Date().toISOString(),
  };
}

function statusText(fields) {
  return `${fields.title} · ${fields.statusLabel}`;
}

function feishuSign(secret, timestamp) {
  return crypto.createHmac("sha256", `${timestamp}\n${secret}`).digest("base64");
}

function dingtalkSignedUrl(url, secret) {
  const timestamp = Date.now();
  const sign = crypto.createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  const parsed = new URL(url);
  parsed.searchParams.set("timestamp", String(timestamp));
  parsed.searchParams.set("sign", sign);
  return parsed.toString();
}

function serverchanUrl(channel) {
  const key = String(channel.sendKey || channel.secret || channel.url || "").trim();
  if (!key) return "";
  if (/^https?:\/\//i.test(key)) return key;
  const id = key.replace(/\.send$/i, "");
  return `https://sctapi.ftqq.com/${id}.send`;
}

function telegramToken(channel) {
  return String(channel.botToken || channel.secret || "")
    .trim()
    .replace(/^bot/i, "");
}

function pickHttpProxy(value) {
  const parts = String(value || "")
    .split(/[\s;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  let fallback = "";
  for (const part of parts) {
    const cut = part.indexOf("=");
    if (cut < 0) {
      if (!/^socks/i.test(part)) fallback = part;
      continue;
    }
    const scheme = part.slice(0, cut).toLowerCase();
    const addr = part.slice(cut + 1).trim();
    if ((scheme === "https" || scheme === "http") && addr && !/^socks/i.test(addr)) return addr;
  }
  return fallback;
}

function envProxy() {
  const keys = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"];
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value && !/^socks/i.test(value)) return value;
  }
  return "";
}

function windowsProxy() {
  if (process.platform !== "win32") return "";
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(out)) return "";
    const line = out.split(/\r?\n/).find((row) => /ProxyServer\s+REG_SZ/i.test(row));
    if (!line) return "";
    return pickHttpProxy(line.replace(/^.*REG_SZ\s+/i, "").trim());
  } catch {
    return "";
  }
}

function detectProxyUrl() {
  return envProxy() || windowsProxy();
}

function resolveProxyUrl() {
  const proxy = readConfig().proxy;
  if (proxy.mode === "manual") return String(proxy.url || "").trim();
  return detectProxyUrl();
}

function parseProxy(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (!parsed.hostname) return null;
  return {
    hostname: parsed.hostname,
    port: Number(parsed.port) || 80,
    auth:
      parsed.username || parsed.password
        ? `${decodeURIComponent(parsed.username)}${parsed.password ? `:${decodeURIComponent(parsed.password)}` : ""}`
        : "",
  };
}

function channelAddressed(channel) {
  if (channel.type === "serverchan") return Boolean(serverchanUrl(channel));
  if (channel.type === "telegram") return Boolean(telegramToken(channel) && channel.chatId);
  return Boolean(channel.url);
}

function buildRequest(channel, fields) {
  const text = statusText(fields);
  if (channel.type === "feishu") {
    const body = { msg_type: "text", content: { text } };
    if (channel.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      body.timestamp = timestamp;
      body.sign = feishuSign(channel.secret, timestamp);
    }
    return {
      url: channel.url,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyText: JSON.stringify(body),
    };
  }
  if (channel.type === "dingtalk") {
    return {
      url: channel.secret ? dingtalkSignedUrl(channel.url, channel.secret) : channel.url,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyText: JSON.stringify({ msgtype: "text", text: { content: text } }),
    };
  }
  if (channel.type === "wecom") {
    return {
      url: channel.url,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyText: JSON.stringify({ msgtype: "text", text: { content: text } }),
    };
  }
  if (channel.type === "kook") {
    return {
      url: channel.url,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyText: JSON.stringify({ type: 1, content: text }),
    };
  }
  if (channel.type === "serverchan") {
    return {
      url: serverchanUrl(channel),
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyText: JSON.stringify({ title: fields.title, desp: text }),
    };
  }
  if (channel.type === "telegram") {
    const token = telegramToken(channel);
    return {
      url: `https://api.telegram.org/bot${token}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyText: JSON.stringify({
        chat_id: channel.chatId,
        text,
        disable_web_page_preview: true,
      }),
    };
  }
  if (channel.type === "webhook") {
    return {
      url: channel.url,
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyText: JSON.stringify({
        title: fields.title,
        status: fields.status,
        statusLabel: fields.statusLabel,
        sessionId: fields.sessionId,
        at: fields.at,
        text,
      }),
    };
  }

  const method = ["GET", "POST", "PUT"].includes(channel.method) ? channel.method : "POST";
  const headerSource = applyTemplate(channel.headers || "", fields, String(channel.headers || "").trim().startsWith("{") ? "json" : "text");
  const headers = parseHeaderText(headerSource);
  const bodyText = applyTemplate(channel.bodyTemplate || DEFAULT_BODY, fields, "json");
  return {
    url: applyTemplate(channel.url, fields, "url"),
    method,
    headers,
    bodyText: method === "GET" ? "" : bodyText,
  };
}

function timeoutError() {
  return new Error(isZh() ? "请求超时" : "Request timed out");
}

function handleResponse(res, resolve, reject) {
  res.resume();
  const code = Number(res.statusCode || 0);
  if (code >= 200 && code < 300) {
    resolve({ ok: true, statusCode: code });
    return;
  }
  reject(new Error(`HTTP ${code}`));
}

function attachTimeout(req, reject) {
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    req.destroy(timeoutError());
  });
  req.on("error", reject);
}

function postDirect(parsed, method, headers, payload, resolve, reject) {
  const lib = parsed.protocol === "https:" ? https : http;
  const req = lib.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
    },
    (res) => handleResponse(res, resolve, reject),
  );
  attachTimeout(req, reject);
  if (payload) req.write(payload);
  req.end();
}

function postHttpProxy(parsed, proxy, method, headers, payload, resolve, reject) {
  const hdrs = { ...headers, Host: parsed.host };
  if (proxy.auth) hdrs["Proxy-Authorization"] = `Basic ${Buffer.from(proxy.auth).toString("base64")}`;
  const req = http.request(
    {
      hostname: proxy.hostname,
      port: proxy.port,
      path: `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`,
      method,
      headers: hdrs,
    },
    (res) => handleResponse(res, resolve, reject),
  );
  attachTimeout(req, reject);
  if (payload) req.write(payload);
  req.end();
}

function postHttpsProxy(parsed, proxy, method, headers, payload, resolve, reject) {
  const connectHeaders = {
    Host: `${parsed.hostname}:${parsed.port || 443}`,
  };
  if (proxy.auth) {
    connectHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(proxy.auth).toString("base64")}`;
  }
  const connectReq = http.request({
    hostname: proxy.hostname,
    port: proxy.port,
    method: "CONNECT",
    path: `${parsed.hostname}:${parsed.port || 443}`,
    headers: connectHeaders,
  });
  attachTimeout(connectReq, reject);
  connectReq.on("connect", (res, socket) => {
    if (Number(res.statusCode || 0) !== 200) {
      socket.destroy();
      reject(new Error(`PROXY ${res.statusCode || 0}`));
      return;
    }
    const tlsSocket = tls.connect({ socket, servername: parsed.hostname }, () => {
      const req = http.request(
        {
          method,
          headers,
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: `${parsed.pathname}${parsed.search}`,
          createConnection: () => tlsSocket,
        },
        (response) => handleResponse(response, resolve, reject),
      );
      attachTimeout(req, reject);
      if (payload) req.write(payload);
      req.end();
    });
    tlsSocket.on("error", reject);
  });
  connectReq.end();
}

function postRequest(request, proxyRaw) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(request.url);
    } catch {
      reject(new Error(isZh() ? "URL 无效" : "Invalid URL"));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error(isZh() ? "只支持 http/https" : "Only http/https URLs are allowed"));
      return;
    }
    const method = ["GET", "POST", "PUT"].includes(request.method) ? request.method : "POST";
    const headers = { ...(request.headers || {}) };
    const payload = method === "GET" || !request.bodyText ? null : Buffer.from(request.bodyText, "utf8");
    if (payload && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }
    if (payload) headers["Content-Length"] = String(payload.length);
    const proxy = parseProxy(proxyRaw);
    if (!proxyRaw) {
      postDirect(parsed, method, headers, payload, resolve, reject);
      return;
    }
    if (!proxy) {
      reject(new Error(isZh() ? "代理地址无效，仅支持 http://host:port" : "Invalid proxy; use http://host:port"));
      return;
    }
    if (parsed.protocol === "http:") {
      postHttpProxy(parsed, proxy, method, headers, payload, resolve, reject);
      return;
    }
    postHttpsProxy(parsed, proxy, method, headers, payload, resolve, reject);
  });
}

function readSessions(db) {
  if (!db) return [];
  try {
    return (
      db
        .prepare(
          `select s.id as id, s.title as title, t.status as status
           from sessions s
           left join turns t on t.id = (
             select id from turns
             where session_id = s.id
             order by started_at desc, id desc
             limit 1
           )
           where s.deleted_at is null`,
        )
        .all() || []
    );
  } catch {
    return [];
  }
}

async function sendOne(channel, fields) {
  const names = channelNames();
  const label = channel.name || names[channel.type] || channel.type;
  try {
    let proxyUrl = "";
    if (channel.useProxy) {
      proxyUrl = resolveProxyUrl();
      if (!proxyUrl) {
        throw new Error(isZh() ? "已开代理但未检测到代理" : "Proxy enabled but none detected");
      }
    }
    const result = await postRequest(buildRequest(channel, fields), proxyUrl);
    pushLog({
      at: fields.at,
      title: fields.title,
      status: fields.status,
      statusLabel: fields.statusLabel,
      sessionId: fields.sessionId,
      channel: label,
      ok: true,
      detail: `HTTP ${result.statusCode}`,
    });
    return { ok: true };
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    pushLog({
      at: fields.at,
      title: fields.title,
      status: fields.status,
      statusLabel: fields.statusLabel,
      sessionId: fields.sessionId,
      channel: label,
      ok: false,
      detail: message,
    });
    return { ok: false, error: message };
  }
}

let focusedCache = { at: 0, value: false };

function foregroundProcessName() {
  if (process.platform === "win32") {
    return String(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Add-Type 'using System;using System.Runtime.InteropServices;public class FgWin{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint pid);}';$h=[FgWin]::GetForegroundWindow();$p=[uint32]0;[void][FgWin]::GetWindowThreadProcessId($h,[ref]$p);(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName",
        ],
        { encoding: "utf8", timeout: 2000, windowsHide: true },
      ) || "",
    ).trim();
  }
  if (process.platform === "darwin") {
    return String(
      execFileSync(
        "osascript",
        ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { encoding: "utf8", timeout: 2000 },
      ) || "",
    ).trim();
  }
  return "";
}

function isHostForeground() {
  const now = Date.now();
  if (now - focusedCache.at < 2000) return focusedCache.value;
  let value = false;
  try {
    const name = foregroundProcessName();
    value = /PI-Desktop|pi-desktop-host-core/i.test(name);
  } catch {
    value = false;
  }
  focusedCache = { at: now, value };
  return value;
}

async function sendChange(session, eventKey, reason, channelId) {
  const config = readConfig();
  if (reason !== "test" && config.notifyWhenFocused === false && isHostForeground()) {
    return { ok: false, skipped: "focused" };
  }
  const fields = payloadFields(session, eventKey);
  let targets;
  if (reason === "test") {
    const one = channelId
      ? config.channels.find((ch) => ch.id === channelId)
      : config.channels.find((ch) => ch.enabled && channelAddressed(ch)) || config.channels[0];
    targets = one ? [one] : [];
  } else {
    targets = config.channels.filter((ch) => ch.enabled && channelAddressed(ch) && ch.events?.[eventKey]);
  }
  if (!targets.length) return { ok: false, skipped: "no-channel" };
  let last = { ok: false, skipped: "no-channel" };
  for (const channel of targets) {
    last = await sendOne(channel, fields);
  }
  return last;
}

async function tick() {
  if (polling) return;
  polling = true;
  const dbFile = path.join(hostRootFromDataPath(await pi.plugin.getDataPath()), "pi.sqlite");
  const db = existsSync(dbFile) ? openHostDb(dbFile) : null;
  try {
    const rows = readSessions(db);
    const next = new Map();
    const changes = [];
    for (const row of rows) {
      const id = String(row.id || "");
      if (!id) continue;
      const eventKey = normalizeEvent(row.status);
      if (!eventKey) continue;
      next.set(id, eventKey);
      const previous = snapshot.get(id);
      if (snapshotReady && previous !== eventKey) {
        changes.push({
          id,
          title: String(row.title || ""),
          eventKey,
        });
      }
    }
    snapshot = next;
    if (!snapshotReady) {
      snapshotReady = true;
      saveState();
      return;
    }
    for (const change of changes) {
      await sendChange(change, change.eventKey, "poll");
    }
    if (changes.length) saveState();
  } finally {
    closeQuietly(db);
    polling = false;
  }
}

function panelState() {
  const config = readConfig();
  return {
    ok: true,
    locale,
    config,
    eventKeys: EVENT_KEYS,
    channelTypes: CHANNEL_TYPES,
    channelNames: channelNames(),
    labels: labels(),
    log: logEntries,
    proxyDetected: detectProxyUrl(),
  };
}

function saveConfig(partial) {
  const current = readConfig();
  pluginConfig = normalizeConfig({
    channels: Array.isArray(partial.channels) ? partial.channels : current.channels,
    proxy: partial.proxy ? { ...current.proxy, ...partial.proxy } : current.proxy,
    notifyWhenFocused:
      typeof partial.notifyWhenFocused === "boolean" ? partial.notifyWhenFocused : current.notifyWhenFocused,
  });
  saveState();
  return panelState();
}

async function migrateLegacySettings() {
  if (pluginConfig.channels.length) return;
  try {
    const settings = await pi.plugin.getSettings();
    if (!settings || typeof settings !== "object") return;
    pluginConfig = normalizeConfig({ ...pluginConfig, ...settings });
    saveState();
  } catch {
    /* host settings page removed */
  }
}

function testFields() {
  return {
    title: isZh() ? "测试推送" : "Test notification",
    status: "test",
    statusLabel: isZh() ? "测试" : "Test",
    sessionId: "test",
    shortId: "test",
    at: new Date().toISOString(),
  };
}

async function testSend(payload) {
  const config = readConfig();
  const one = payload?.channelId
    ? config.channels.find((ch) => ch.id === payload.channelId)
    : config.channels.find((ch) => ch.enabled && channelAddressed(ch)) || config.channels[0];
  if (!one) return { ok: false, skipped: "no-channel" };
  return sendOne(one, testFields());
}

async function refreshLocale() {
  try {
    const raw = String((await pi.app.getLocale()) || "").toLowerCase();
    locale = raw.startsWith("zh") ? "zh-CN" : "en";
  } catch {
    locale = "zh-CN";
  }
}

function startPolling() {
  if (pollTimer) return;
  void tick();
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function onLoad() {
  const dataPath = await pi.plugin.getDataPath();
  stateFile = path.join(dataPath, "notify-state.json");
  loadState();
  await migrateLegacySettings();
  await refreshLocale();
  await pi.commands.register({
    id: COMMAND_ID,
    title: "Session Notify: Open",
    keywords: ["notify", "feishu", "webhook", "telegram", "通知", "飞书", "Telegram"],
    category: "Session",
    run: () => pi.ui.openPanel(),
  });
  try {
    await pi.services.register({
      id: SERVICE_ID,
      start: async () => {
        startPolling();
      },
      stop: async () => {
        stopPolling();
      },
    });
  } catch {
    /* host still starts declared services after onLoad */
  }
  startPolling();
}

async function onUnload() {
  stopPolling();
  saveState();
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    /* ignore */
  }
  try {
    await pi.services.unregister(SERVICE_ID);
  } catch {
    /* ignore */
  }
}

async function onPanelInvoke(channel, payload) {
  if (channel === "notify.get") return panelState();
  if (channel === "notify.save") return saveConfig(payload || {});
  if (channel === "notify.test") return testSend(payload || {});
  return { ok: false, error: `unknown channel: ${channel}` };
}

module.exports = { onLoad, onUnload, onPanelInvoke };
