const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const pipelineCore = require("./public/pipeline-core.js");
const { createXanoBackend, BackendError } = require("./lib/xano-backend.js");
const { monitorRequest } = require("./lib/request-monitor.js");

const PORT = Number(process.env.PORT || process.env.PIPECHAT_AI_PORT || 8787);
const HOST = process.env.PIPECHAT_HOST || "0.0.0.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.PIPECHAT_MODEL || "gpt-4.1-mini";
const DATA_DIR = process.env.PIPECHAT_DATA_DIR || path.join(__dirname, "data");
const AUTH_FILE = path.join(DATA_DIR, "pipechat-auth.json");
const FREE_CHAT_LIMIT = Number(process.env.PIPECHAT_FREE_CHAT_LIMIT || 1000);
const STATIC_ROOT = path.join(__dirname, "public");
const STORAGE_PROVIDER = process.env.PIPECHAT_STORAGE_PROVIDER || "json";
if (!["json", "xano"].includes(STORAGE_PROVIDER)) throw new Error("PIPECHAT_STORAGE_PROVIDER must be json or xano.");
const xano = STORAGE_PROVIDER === "xano" ? createXanoBackend({
  baseUrl: process.env.XANO_API_BASE_URL,
  serverKey: process.env.XANO_SERVER_KEY
}) : null;
const SESSION_COOKIE = process.env.PIPECHAT_SESSION_COOKIE || (xano ? "pipechat_xano_session" : "pipechat_session");
if (!/^[A-Za-z0-9_-]+$/.test(SESSION_COOKIE)) throw new Error("PIPECHAT_SESSION_COOKIE must be a valid cookie name.");
const SECURE_COOKIE = process.env.NODE_ENV === "production" || process.env.PIPECHAT_COOKIE_SECURE === "true";
const userQueues = new Map();

// Serialize each user's writes and AI usage reservations within this single-process prototype.
async function userLock(key, task) {
  const previous = userQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  userQueues.set(key, current);
  await previous;
  try { return await task(); }
  finally { release(); if (userQueues.get(key) === current) userQueues.delete(key); }
}

const actionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["filter_view", "clear_view", "update_record", "bulk_update", "add_record", "delete_record", "import_records", "import_mapping", "clarify"]
    },
    field: {
      type: ["string", "null"],
      enum: ["account", "owner", "stage", "value", "close", "next", "follow", "activity", "health", null]
    },
    operator: {
      type: ["string", "null"],
      enum: ["equals", "contains", "is_blank", null]
    },
    value: {
      type: ["string", "number", "null"]
    },
    label: {
      type: ["string", "null"]
    },
    title: {
      type: ["string", "null"]
    },
    summary: {
      type: ["string", "null"]
    },
    risk: {
      type: ["string", "null"],
      enum: ["Low", "Medium", "High", null]
    },
    recordMatch: {
      type: ["string", "null"]
    },
    ids: {
      type: ["array", "null"],
      items: { type: "number" }
    },
    filter: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            field: {
              type: "string",
              enum: ["account", "owner", "stage", "value", "close", "next", "follow", "activity", "health"]
            },
            operator: {
              type: "string",
              enum: ["equals", "contains", "is_blank"]
            },
            value: {
              type: ["string", "number", "null"]
            }
          },
          required: ["field", "operator", "value"]
        }
      ]
    },
    record: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: ["string", "null"] },
            owner: { type: ["string", "null"] },
            stage: { type: ["string", "null"] },
            value: { type: ["number", "null"] },
            close: { type: ["string", "null"] },
            next: { type: ["string", "null"] },
            follow: { type: ["string", "null"] },
            notes: { type: ["string", "null"] }
          },
          required: ["account", "owner", "stage", "value", "close", "next", "follow", "notes"]
        }
      ]
    },
    records: {
      anyOf: [
        { type: "null" },
        {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              account: { type: ["string", "null"] },
              owner: { type: ["string", "null"] },
              stage: { type: ["string", "null"] },
              value: { type: ["number", "null"] },
              close: { type: ["string", "null"] },
              next: { type: ["string", "null"] },
              follow: { type: ["string", "null"] },
              notes: { type: ["string", "null"] }
            },
            required: ["account", "owner", "stage", "value", "close", "next", "follow", "notes"]
          }
        }
      ]
    },
    mode: {
      type: ["string", "null"]
    },
    columnMap: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            account: { type: ["string", "null"] },
            owner: { type: ["string", "null"] },
            stage: { type: ["string", "null"] },
            value: { type: ["string", "null"] },
            close: { type: ["string", "null"] },
            next: { type: ["string", "null"] },
            follow: { type: ["string", "null"] },
            notes: { type: ["string", "null"] }
          },
          required: ["account", "owner", "stage", "value", "close", "next", "follow", "notes"]
        }
      ]
    },
    question: {
      type: ["string", "null"]
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          value: { type: "string" }
        },
        required: ["label", "value"]
      }
    }
  },
  required: [
    "action",
    "field",
    "operator",
    "value",
    "label",
    "title",
    "summary",
    "risk",
    "recordMatch",
    "ids",
    "filter",
    "record",
    "records",
    "mode",
    "columnMap",
    "question",
    "assumptions"
  ]
};

// The model selects validated actions and chart specifications; it supplies no report totals.
actionSchema.properties.action.enum.push("update_records", "show_report", "share_view");
actionSchema.properties.field.enum.push("notes");
actionSchema.properties.operator.enum = [...pipelineCore.operators, null];
actionSchema.properties.filter.anyOf[1].properties.field.enum.push("notes");
actionSchema.properties.filter.anyOf[1].properties.operator.enum = pipelineCore.operators;
actionSchema.properties.changes = {
  anyOf: [ { type: "null" }, {
    type: "array",
    items: {
      type: "object", additionalProperties: false,
      properties: {
        recordMatch: { type: ["string", "null"] },
        ids: { type: ["array", "null"], items: { type: "number" } },
        filter: actionSchema.properties.filter,
        field: { type: "string", enum: Object.keys(pipelineCore.fields) },
        value: { type: ["string", "number"] },
        operation: { type: "string", enum: ["set", "append"] }
      },
      required: ["recordMatch", "ids", "filter", "field", "value", "operation"]
    }
  } ]
};
actionSchema.properties.report = {
  anyOf: [ { type: "null" }, {
    type: "object", additionalProperties: false,
    properties: {
      metric: { type: "string", enum: ["sum", "count", "average"] },
      field: { type: "string", enum: ["value"] },
      groupBy: { type: "string", enum: ["owner", "stage", "close_month", "none"] },
      chart: { type: "string", enum: ["bar", "line", "stage", "kpi"] },
      filter: actionSchema.properties.filter,
      from: { type: ["string", "null"] },
      to: { type: ["string", "null"] }
    },
    required: ["metric", "field", "groupBy", "chart", "filter", "from", "to"]
  } ]
};
actionSchema.required.push("changes", "report");

const pipechatResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assistantMessage: {
      type: "string"
    },
    crmAction: {
      anyOf: [
        { type: "null" },
        actionSchema
      ]
    },
    memoryNote: {
      type: ["string", "null"]
    }
  },
  required: ["assistantMessage", "crmAction", "memoryNote"]
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function sendJsonWithHeaders(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(text);
}

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new RequestError("Request body too large", 413));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readPayload(req) {
  const body = await readBody(req);
  let payload;
  try { payload = JSON.parse(body || "{}"); }
  catch { throw new RequestError("Request body must be valid JSON.", 400); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RequestError("Request body must be a JSON object.", 400);
  }
  return payload;
}

function extractOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("");
}

function userDataFile(userId, fileName) {
  return path.join(DATA_DIR, "users", userId, fileName);
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  for (const part of cookie.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return null;
}

async function readAuthStore() {
  try {
    const text = await fs.readFile(AUTH_FILE, "utf8");
    const payload = JSON.parse(text);
    return {
      users: Array.isArray(payload.users) ? payload.users : [],
      sessions: payload.sessions && typeof payload.sessions === "object" ? payload.sessions : {}
    };
  } catch (error) {
    if (error.code === "ENOENT") return { users: [], sessions: {} };
    throw error;
  }
}

async function writeAuthStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${AUTH_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2));
  await fs.rename(tempFile, AUTH_FILE);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || ""
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHash] = String(stored || "").split(":");
  if (!salt || !expectedHash) return false;
  const actualHash = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"));
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${xano ? 86400 : 2592000}${SECURE_COOKIE ? "; Secure" : ""}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE ? "; Secure" : ""}`;
}

async function getAuthenticatedUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  if (xano) return xano.getUser(token);
  const store = await readAuthStore();
  const session = store.sessions[token];
  if (!session) return null;
  const user = store.users.find(item => item.id === session.userId);
  return user || null;
}

async function requireUser(req, res) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Please sign in to access your PipeChat CRM." });
    return null;
  }
  return user;
}

function normalizeDeal(input, index) {
  return {
    id: Number(input.id) || index + 1,
    account: String(input.account || "").trim(),
    owner: String(input.owner || "").trim(),
    stage: String(input.stage || "Discovery").trim(),
    value: Number(input.value || 0),
    close: String(input.close || "").trim(),
    next: String(input.next ?? "").trim(),
    follow: String(input.follow ?? "").trim(),
    activity: String(input.activity || "just now").trim(),
    health: String(input.health || "updated").trim(),
    notes: String(input.notes || "").trim(),
    history: Array.isArray(input.history) ? input.history.map(item => String(item)) : []
  };
}

async function readCrmData(userId) {
  const dataFile = userDataFile(userId, "pipechat-crm-data.json");
  try {
    const text = await fs.readFile(dataFile, "utf8");
    const payload = JSON.parse(text);
    return {
      deals: Array.isArray(payload.deals) ? payload.deals.map(normalizeDeal).filter(deal => deal.account) : [],
      updatedAt: payload.updatedAt || null
    };
  } catch (error) {
    if (error.code === "ENOENT") return { deals: [], updatedAt: null };
    throw error;
  }
}

async function writeCrmData(userId, deals) {
  const dataFile = userDataFile(userId, "pipechat-crm-data.json");
  const payload = {
    updatedAt: new Date().toISOString(),
    deals: deals.map(normalizeDeal).filter(deal => deal.account)
  };
  const tempFile = `${dataFile}.tmp`;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2));
  await fs.rename(tempFile, dataFile);
  return payload;
}

async function readChatUsage(userId) {
  const usageFile = userDataFile(userId, "pipechat-chat-usage.json");
  try {
    const text = await fs.readFile(usageFile, "utf8");
    const payload = JSON.parse(text);
    const used = Number(payload.used || 0);
    return {
      used: Number.isFinite(used) ? used : 0,
      limit: FREE_CHAT_LIMIT,
      remaining: Math.max(FREE_CHAT_LIMIT - (Number.isFinite(used) ? used : 0), 0),
      paymentRequired: used >= FREE_CHAT_LIMIT,
      updatedAt: payload.updatedAt || null
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        used: 0,
        limit: FREE_CHAT_LIMIT,
        remaining: FREE_CHAT_LIMIT,
        paymentRequired: false,
        updatedAt: null
      };
    }
    throw error;
  }
}

async function incrementChatUsage(userId) {
  const usageFile = userDataFile(userId, "pipechat-chat-usage.json");
  const current = await readChatUsage(userId);
  const used = current.used + 1;
  const payload = {
    used,
    limit: FREE_CHAT_LIMIT,
    remaining: Math.max(FREE_CHAT_LIMIT - used, 0),
    paymentRequired: used >= FREE_CHAT_LIMIT,
    updatedAt: new Date().toISOString()
  };
  const tempFile = `${usageFile}.tmp`;
  await fs.mkdir(path.dirname(usageFile), { recursive: true });
  await fs.writeFile(tempFile, JSON.stringify(payload, null, 2));
  await fs.rename(tempFile, usageFile);
  return payload;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(STATIC_ROOT, `.${requestedPath}`);
  const relativePath = path.relative(STATIC_ROOT, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    const text = await fs.readFile(filePath, "utf8");
    const contentType = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".js")
      ? "application/javascript; charset=utf-8"
      : filePath.endsWith(".json")
      ? "application/json; charset=utf-8"
      : filePath.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/plain; charset=utf-8";
    return sendText(res, 200, text, contentType);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(res, 404, { error: "Not found" });
    throw error;
  }
}

async function planPipeChatAction({ instructions, userCommand, pipeline, conversationHistory = [], pendingClarification = null, pendingAction = null, currentReport = null, csvImport = null }) {
  if (!OPENAI_API_KEY) {
    throw new RequestError("OPENAI_API_KEY is not set", 503);
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    ...(xano ? { signal: AbortSignal.timeout(80000) } : {}),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: [
        instructions,
        "PipeChat prototype: propose actions only. The app resolves targets, validates, calculates, previews and writes only after user confirmation.",
        "Use update_records with changes for multi-field or multi-company requests. Repeat the original recordMatch for each field. Use append for adding notes; preserve existing notes.",
        "Keep the user's original company reference in recordMatch even if you supply IDs. Ask for clarification if identity is ambiguous; never guess a company or missing business value.",
        "For bulk updates use filters, not a guessed list of IDs. month_equals on close uses a month number from 1 to 12 and works across years. Ask for the year if a target date is unclear.",
        "Use show_report with report specifying metric, field, groupBy, chart, filter, from and to. Pipeline by rep means sum value grouped by owner. Deals by stage means count grouped by stage. Monthly trends use close_month. Dates use YYYY-MM-DD. Never supply calculated totals; the app calculates them.",
        "Questions asking for totals, averages or counts must use show_report (kpi is available), not an unverified numerical answer in conversation. A single filter supports equals, contains, is_blank, gt, gte, lt, lte, month_equals; do not silently drop additional requested conditions that this prototype cannot represent.",
        "Use currentReport for refinements such as now only Q3. Do not silently drop previous chart filters unless the user requests a reset.",
        "Use pendingAction to revise a draft, retaining its other changes. Return the complete revised action. No draft has been applied yet.",
        "Use share_view for sharing requests. This is a local read-only preview only; no invite or external share is actually sent. Put a requested recipient in value.",
        "Dynamic schema, recruiting/other domains, production permissions, billing and integrations are future work. Do not claim these features exist. Normal conversation returns crmAction null."
      ].filter(Boolean).join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                task: "Respond as a conversational CRM assistant. Include a CRM action only when the user wants to view, add, rename, or edit pipeline data.",
                userCommand,
                pipeline,
                conversationHistory,
                pendingClarification,
                pendingAction,
                currentReport,
                csvImport,
                importRule: "When csvImport is present, inspect its headers and sample rows and return crmAction.action import_mapping with columnMap values that exactly match CSV header names or null. Set mode to Append rows because CSV imports add rows to the existing CRM table rather than replacing it. The app will apply the mapping to every CSV row. Explain mapping assumptions in assistantMessage and assumptions.",
                clarificationRule: [
                  "If pendingClarification exists, the latest userCommand may be an answer to that clarification.",
                  "For yes/affirmative answers, resolve pendingClarification.originalCommand using the yes answer.",
                  "For short answers like a person's name, stage, date, owner, or value, use it as the missing clarification detail.",
                  "Do not respond that the word yes or no is unclear when pendingClarification is present.",
                  "Only ask another clarification if the pending clarification answer is still insufficient for a safe table action."
                ].join(" ")
              })
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "pipechat_response",
          strict: true,
          schema: pipechatResponseSchema
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const messages = {
      401: "The AI provider rejected the server credentials. Check OPENAI_API_KEY.",
      429: "The AI provider is rate limiting requests or has no available quota."
    };
    throw new RequestError(messages[response.status] || "The AI provider could not complete the request. No CRM changes were made.", 502);
  }

  const outputText = extractOutputText(data);
  if (!outputText) {
    throw new Error("Model returned no action JSON");
  }

  return JSON.parse(outputText);
}

const server = http.createServer(async (req, res) => {
  monitorRequest(req, res);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  if (SECURE_COOKIE) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    // Browser writes must originate from this app. The Xano bearer token stays in an HttpOnly cookie.
    if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method) && url.pathname.startsWith("/api/")) {
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        return sendJson(res, 415, { error: "Use application/json for API requests." });
      }
      const expectedOrigin = process.env.PIPECHAT_PUBLIC_ORIGIN || `${SECURE_COOKIE ? "https" : "http"}://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== new URL(expectedOrigin).origin) {
        return sendJson(res, 403, { error: "Cross-origin writes are not allowed." });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        app: "PipeChat",
        model: OPENAI_MODEL,
        aiConfigured: Boolean(OPENAI_API_KEY),
        prototypeVersion: "product-v2",
        freeChatLimit: xano ? null : FREE_CHAT_LIMIT,
        storageProvider: STORAGE_PROVIDER
      });
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const user = await getAuthenticatedUser(req);
      return sendJson(res, 200, { user: user ? publicUser(user) : null });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      const payload = await readPayload(req);
      const email = String(payload.email || "").trim().toLowerCase();
      const password = String(payload.password || "");
      const name = String(payload.name || "").trim();
      if (!email.includes("@") || password.length < 8) {
        return sendJson(res, 400, { error: "Use a valid email and a password with at least 8 characters." });
      }
      if (xano) {
        const result = await xano.authenticate("signup", { email, password, name });
        return sendJsonWithHeaders(res, 200, { user: result.user }, { "Set-Cookie": sessionCookie(result.token) });
      }
      const store = await readAuthStore();
      if (store.users.some(user => user.email === email)) {
        return sendJson(res, 409, { error: "An account with that email already exists. Sign in instead." });
      }
      const user = {
        id: crypto.randomUUID(),
        email,
        name,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString()
      };
      const token = crypto.randomBytes(32).toString("hex");
      store.users.push(user);
      store.sessions[token] = { userId: user.id, createdAt: new Date().toISOString() };
      await writeAuthStore(store);
      return sendJsonWithHeaders(res, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const payload = await readPayload(req);
      const email = String(payload.email || "").trim().toLowerCase();
      const password = String(payload.password || "");
      if (xano) {
        const result = await xano.authenticate("login", { email, password });
        return sendJsonWithHeaders(res, 200, { user: result.user }, { "Set-Cookie": sessionCookie(result.token) });
      }
      const store = await readAuthStore();
      const user = store.users.find(item => item.email === email);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return sendJson(res, 401, { error: "Email or password is incorrect." });
      }
      const token = crypto.randomBytes(32).toString("hex");
      store.sessions[token] = { userId: user.id, createdAt: new Date().toISOString() };
      await writeAuthStore(store);
      return sendJsonWithHeaders(res, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token) });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const token = getCookie(req, SESSION_COOKIE);
      if (xano) {
        await xano.logout(token);
        return sendJsonWithHeaders(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
      }
      if (token) {
        const store = await readAuthStore();
        delete store.sessions[token];
        await writeAuthStore(store);
      }
      return sendJsonWithHeaders(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (req.method === "GET" && url.pathname === "/api/crm-data") {
      const user = await requireUser(req, res);
      if (!user) return;
      const data = xano ? await xano.readCrm(getCookie(req, SESSION_COOKIE)) : await readCrmData(user.id);
      return sendJson(res, 200, { ...data, seedDemoData: !xano });
    }

    if (req.method === "GET" && url.pathname === "/api/chat-usage") {
      const user = await requireUser(req, res);
      if (!user) return;
      const usage = xano ? await xano.readUsage(getCookie(req, SESSION_COOKIE)) : await readChatUsage(user.id);
      return sendJson(res, 200, usage);
    }

    if (req.method === "PUT" && url.pathname === "/api/crm-data") {
      const user = await requireUser(req, res);
      if (!user) return;
      const payload = await readPayload(req);
      if (!Array.isArray(payload.deals)) {
        return sendJson(res, 400, { error: "Expected { deals: [...] }" });
      }
      if (xano && payload.deals.length > 2000) return sendJson(res, 400, { error: "This integration supports up to 2,000 deals per CRM snapshot." });
      try {
        const ids = new Set();
        for (const record of payload.deals) {
          if (!record || !Number.isSafeInteger(record.id) || record.id < 1 || ids.has(record.id)) throw new Error("Record IDs must be unique positive integers.");
          if (!Object.hasOwn(record, "account")) throw new Error("Company name is required.");
          ids.add(record.id);
          for (const field of Object.keys(pipelineCore.fields)) {
            if (Object.hasOwn(record, field)) record[field] = pipelineCore.validateValue(field, record[field]);
          }
        }
      } catch (error) { return sendJson(res, 400, { error: error.message }); }
      if (xano) {
        const saved = await xano.writeCrm(getCookie(req, SESSION_COOKIE), payload.deals.map(normalizeDeal), payload.expectedUpdatedAt);
        return sendJson(res, 200, saved);
      }
      return await userLock(`crm:${user.id}`, async () => {
        const current = await readCrmData(user.id);
        if (Object.hasOwn(payload, "expectedUpdatedAt") && payload.expectedUpdatedAt !== current.updatedAt) {
          return sendJson(res, 409, { error: "This CRM was updated in another window. Refresh before saving; your new change has not been applied." });
        }
        const saved = await writeCrmData(user.id, payload.deals);
        return sendJson(res, 200, saved);
      });
    }

    if (req.method === "POST" && url.pathname === "/api/pipechat-ai") {
      const user = await requireUser(req, res);
      if (!user) return;
      const payload = await readPayload(req);
      if (xano) {
        if (!OPENAI_API_KEY) return sendJson(res, 503, { error: "OPENAI_API_KEY is not set. No chat allowance was reserved." });
        const token = getCookie(req, SESSION_COOKIE);
        const reservation = await xano.reserveUsage(token, crypto.randomUUID());
        let action;
        try {
          action = await planPipeChatAction(payload);
        } catch (error) {
          let usage;
          try { usage = await xano.finishUsage(token, reservation.reservationId, "release"); }
          catch { /* An abandoned reservation expires in Xano; never fall back to a local counter. */ }
          return sendJson(res, 502, { error: "The AI request failed. No CRM changes were made. Any unreleased chat reservation expires within five minutes.", ...(usage ? { usage } : {}) });
        }
        // Finalization is idempotent. Never rerun the paid model call to retry usage accounting.
        let usage;
        try { usage = await xano.finishUsage(token, reservation.reservationId, "commit"); }
        catch { usage = await xano.finishUsage(token, reservation.reservationId, "commit"); }
        return sendJson(res, 200, { ...action, usage });
      }
      return await userLock(`ai:${user.id}`, async () => {
      const usage = await readChatUsage(user.id);
      if (usage.paymentRequired) {
        return sendJson(res, 402, {
          error: "Free chatbot usage limit reached. Payment is required to continue using the AI chatbot.",
          usage
        });
      }
      const action = await planPipeChatAction(payload);
      const updatedUsage = await incrementChatUsage(user.id);
      return sendJson(res, 200, { ...action, usage: updatedUsage });
      });
    }

    if (req.method === "GET") {
      return await serveStatic(req, res);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const expected = error instanceof BackendError || error instanceof RequestError;
    const status = expected ? error.status : 500;
    return sendJson(res, status, {
      error: expected ? error.message : "PipeChat could not complete the request. Please try again.",
      ...(error instanceof BackendError && error.usage ? { usage: error.usage } : {})
    });
  }
});

async function start() {
  if (xano) await xano.check();
  server.listen(PORT, HOST, () => {
    console.log(`PipeChat app running at http://127.0.0.1:${PORT}/`);
    console.log(`PipeChat AI server running at http://127.0.0.1:${PORT}/api/pipechat-ai`);
    console.log(`PipeChat storage: ${STORAGE_PROVIDER}`);
    console.log(`Free AI messages per user: ${xano ? "managed in Xano" : FREE_CHAT_LIMIT}`);
    console.log(`Model: ${OPENAI_MODEL}`);
  });
}
start().catch(error => {
  console.error(error instanceof BackendError ? `[PipeChat startup] ${error.message}` : "[PipeChat startup] Unable to start. Check server configuration and backend availability.");
  process.exitCode = 1;
});
