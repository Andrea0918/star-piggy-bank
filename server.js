import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(ROOT, "index.html");
const PORT = Number(process.env.PORT) || 10000;
const FAMILY_ID = process.env.FAMILY_ID || "our-family";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
const COOKIE_NAME = "star_family_session";
const DEVICE_COOKIE = "star_family_device";
const SESSION_VALUE = ACCESS_TOKEN
  ? crypto.createHmac("sha256", ACCESS_TOKEN).update(FAMILY_ID).digest("hex")
  : "";
const TIME_ZONE = "Asia/Shanghai";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY = 3000;

let pool = null;
let memoryState = null;
let memoryVersion = 0;

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function dayKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function uniqueStrings(...values) {
  return [...new Set(values.flat().filter((value) => typeof value === "string" && value))];
}

function normalizeItem(item) {
  return item && typeof item === "object" && typeof item.id === "string" ? item : null;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...source,
    child: source.child && typeof source.child === "object" ? source.child : {},
    settings: source.settings && typeof source.settings === "object" ? source.settings : {},
    tasks: Array.isArray(source.tasks) ? source.tasks.filter(normalizeItem) : [],
    wishes: Array.isArray(source.wishes) ? source.wishes.filter(normalizeItem) : [],
    history: Array.isArray(source.history) ? source.history.filter(normalizeItem) : [],
    daily: source.daily && typeof source.daily === "object"
      ? source.daily
      : { date: dayKey(), rewards: {}, penalties: {} },
    deletedTaskIds: uniqueStrings(source.deletedTaskIds),
    deletedWishIds: uniqueStrings(source.deletedWishIds),
    deletedTransactionIds: uniqueStrings(source.deletedTransactionIds)
  };
}

function mergeState(currentValue, incomingValue) {
  const current = normalizeState(currentValue || {});
  const incoming = normalizeState(incomingValue || {});

  const deletedTransactionIds = uniqueStrings(current.deletedTransactionIds, incoming.deletedTransactionIds);
  const deletedTaskIds = uniqueStrings(current.deletedTaskIds, incoming.deletedTaskIds);
  const deletedWishIds = uniqueStrings(current.deletedWishIds, incoming.deletedWishIds);

  const historyById = new Map();
  for (const item of [...current.history, ...incoming.history]) {
    if (!item || typeof item.id !== "string") continue;
    if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) continue;
    historyById.set(item.id, item);
  }
  const deletedTransactionSet = new Set(deletedTransactionIds);
  const history = [...historyById.values()]
    .filter((item) => !deletedTransactionSet.has(item.id))
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
    .slice(0, MAX_HISTORY);

  const taskById = new Map();
  for (const item of [...current.tasks, ...incoming.tasks]) {
    if (item && typeof item.id === "string") taskById.set(item.id, item);
  }
  const deletedTaskSet = new Set(deletedTaskIds);
  const tasks = [...taskById.values()].filter((item) => !deletedTaskSet.has(item.id));

  const wishById = new Map();
  for (const item of [...current.wishes, ...incoming.wishes]) {
    if (item && typeof item.id === "string") wishById.set(item.id, item);
  }
  const deletedWishSet = new Set(deletedWishIds);
  const wishes = [...wishById.values()].filter((item) => !deletedWishSet.has(item.id));

  const wishTransactions = new Map(
    history
      .filter((item) => item.type === "wish" && typeof item.taskId === "string")
      .map((item) => [item.taskId, item])
  );
  for (const wish of wishes) {
    const transaction = wishTransactions.get(wish.id);
    if (transaction) wish.completedAt = wish.completedAt || transaction.at || new Date().toISOString();
  }

  const balance = roundMoney(history.reduce((total, item) => total + Number(item.amount || 0), 0));
  const stars = history
    .filter((item) => item.type === "reward" && Number(item.amount) > 0)
    .reduce((total, item) => total + Math.max(0, Number(item.starsEarned) || 0), 0);

  const today = dayKey();
  const rewards = {};
  const penalties = {};
  for (const transaction of history) {
    if (transaction.type !== "reward" && transaction.type !== "penalty") continue;
    if (dayKey(new Date(transaction.at)) !== today || typeof transaction.taskId !== "string") continue;
    if (transaction.type === "reward") {
      rewards[transaction.taskId] = transaction.id;
    } else {
      if (!Array.isArray(penalties[transaction.taskId])) penalties[transaction.taskId] = [];
      penalties[transaction.taskId].push(transaction.id);
    }
  }

  const merged = {
    ...current,
    ...incoming,
    child: { ...current.child, ...incoming.child },
    settings: { ...current.settings, ...incoming.settings },
    tasks,
    wishes,
    history,
    balance,
    stars,
    daily: { date: today, rewards, penalties },
    deletedTaskIds,
    deletedWishIds,
    deletedTransactionIds
  };

  delete merged.version;
  return merged;
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        if (index < 0) return [item, ""];
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function isAuthorized(request) {
  if (!ACCESS_TOKEN) return true;
  return parseCookies(request.headers.cookie || "")[COOKIE_NAME] === SESSION_VALUE;
}

function entryCookie(value, maxAge = 31536000) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

function deviceCookie(value) {
  return `${DEVICE_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function sendText(response, status, text, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(text);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求内容不是有效 JSON");
    error.statusCode = 400;
    throw error;
  }
}

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL 未设置，使用内存存储（仅用于本地测试）。");
    return;
  }
  const { Pool } = await import("pg");
  const connectionUrl = new URL(process.env.DATABASE_URL);
  const needsSsl = process.env.PGSSLMODE !== "disable"
    && (/sslmode=(require|verify-ca|verify-full)/.test(process.env.DATABASE_URL)
      || connectionUrl.hostname.includes("."));
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS star_piggy_bank_state (
      family_id TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("Postgres 同步存储已就绪。");
}

async function loadState() {
  if (!pool) {
    return { state: memoryState, version: memoryVersion };
  }
  const result = await pool.query(
    "SELECT state, version FROM star_piggy_bank_state WHERE family_id = $1",
    [FAMILY_ID]
  );
  if (!result.rowCount) return { state: null, version: 0 };
  return { state: result.rows[0].state, version: Number(result.rows[0].version) };
}

async function syncState(incomingState) {
  if (!incomingState || typeof incomingState !== "object" || Array.isArray(incomingState)) {
    const error = new Error("账本数据格式不正确");
    error.statusCode = 400;
    throw error;
  }

  if (!pool) {
    memoryState = mergeState(memoryState, incomingState);
    memoryVersion += 1;
    return { state: memoryState, version: memoryVersion, changed: true };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT state, version FROM star_piggy_bank_state WHERE family_id = $1 FOR UPDATE",
      [FAMILY_ID]
    );
    const current = result.rowCount ? result.rows[0] : null;
    const merged = mergeState(current?.state, incomingState);
    const changed = !current || stableStringify(current.state) !== stableStringify(merged);
    let version = current ? Number(current.version) : 0;
    if (!current) {
      await client.query(
        "INSERT INTO star_piggy_bank_state (family_id, state, version) VALUES ($1, $2::jsonb, 1)",
        [FAMILY_ID, JSON.stringify(merged)]
      );
      version = 1;
    } else if (changed) {
      version += 1;
      await client.query(
        "UPDATE star_piggy_bank_state SET state = $2::jsonb, version = $3, updated_at = NOW() WHERE family_id = $1",
        [FAMILY_ID, JSON.stringify(merged), version]
      );
    }
    await client.query("COMMIT");
    return { state: merged, version, changed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function serveIndex(response) {
  const html = await fsp.readFile(INDEX_PATH);
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": html.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()"
  });
  response.end(html);
}

function unauthorizedPage(response) {
  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>星星钱罐</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef9f1;color:#23443c;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{width:min(430px,calc(100% - 40px));padding:28px;border:1px solid #cae8d7;border-radius:8px;background:#fffdf7}
h1{margin:0 0 10px;font-size:25px}p{margin:0;color:#60736b;font-size:14px;line-height:1.7}
</style>
<main><h1>请从专用入口打开</h1><p>请使用发送到手机或 iPad 的星星钱罐专用地址。首次打开后会记住这台设备。</p></main>
</html>`;
  response.writeHead(403, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function chooseDevice(request, url) {
  const requested = url.searchParams.get("device");
  if (requested === "ipad" || requested === "phone") return requested;
  const agent = request.headers["user-agent"] || "";
  return /iPad|Tablet/i.test(agent) ? "ipad" : "phone";
}

async function handleRequest(request, response) {
  const base = `http://${request.headers.host || "localhost"}`;
  const url = new URL(request.url || "/", base);
  const pathname = url.pathname;

  if (pathname === "/api/health") {
    const mode = pool ? "postgres" : "memory";
    sendJson(response, 200, { ok: true, mode, familyId: FAMILY_ID, time: new Date().toISOString() });
    return;
  }

  if (pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
    response.end();
    return;
  }

  if (pathname === "/api/state" && request.method === "GET") {
    if (!isAuthorized(request)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const result = await loadState();
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (pathname === "/api/sync" && request.method === "POST") {
    if (!isAuthorized(request)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request);
    const result = await syncState(body.state);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (pathname === "/enter" || pathname === "/ipad" || pathname === "/phone") {
    const suppliedKey = url.searchParams.get("key");
    if (ACCESS_TOKEN && suppliedKey === ACCESS_TOKEN) {
      const device = pathname === "/enter" ? chooseDevice(request, url) : pathname.slice(1);
      response.writeHead(302, {
        Location: device === "ipad" ? "/ipad" : "/phone",
        "Set-Cookie": [entryCookie(SESSION_VALUE), deviceCookie(device)],
        "Cache-Control": "no-store"
      });
      response.end();
      return;
    }
  }

  if (pathname === "/" || pathname === "/ipad" || pathname === "/phone") {
    if (!isAuthorized(request)) {
      unauthorizedPage(response);
      return;
    }
    if (pathname === "/" && ACCESS_TOKEN) {
      const device = parseCookies(request.headers.cookie || "")[DEVICE_COOKIE];
      response.writeHead(302, { Location: device === "ipad" ? "/ipad" : "/phone", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    await serveIndex(response);
    return;
  }

  if (pathname === "/render.yaml" || pathname === "/server.js" || pathname === "/package.json") {
    sendText(response, 404, "Not found");
    return;
  }

  if (!path.extname(pathname)) {
    if (!isAuthorized(request)) {
      unauthorizedPage(response);
      return;
    }
    await serveIndex(response);
    return;
  }

  sendText(response, 404, "Not found");
}

await initDatabase();

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);
    if (response.headersSent) {
      response.end();
      return;
    }
    sendJson(response, error.statusCode || 500, {
      ok: false,
      error: error.statusCode ? error.message : "internal_error"
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`星星钱罐运行在 http://0.0.0.0:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
