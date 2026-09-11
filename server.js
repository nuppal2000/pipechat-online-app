const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || process.env.PIPECHAT_AI_PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.PIPECHAT_MODEL || "gpt-4.1-mini";
const DATA_DIR = process.env.PIPECHAT_DATA_DIR || path.join(__dirname, "data");
const AUTH_FILE = path.join(DATA_DIR, "pipechat-auth.json");
const FREE_CHAT_LIMIT = Number(process.env.PIPECHAT_FREE_CHAT_LIMIT || 1000);
const STATIC_ROOT = path.join(__dirname, "public");
const SESSION_COOKIE = "pipechat_session";

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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function sendJsonWithHeaders(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
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
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

async function getAuthenticatedUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
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
    next: String(input.next || "Set next step").trim(),
    follow: String(input.follow || "This week").trim(),
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
      : "text/plain; charset=utf-8";
    return sendText(res, 200, text, contentType);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(res, 404, { error: "Not found" });
    throw error;
  }
}

async function planPipeChatAction({ instructions, userCommand, pipeline, conversationHistory = [], pendingClarification = null, csvImport = null }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions,
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
    const message = data.error && data.error.message ? data.error.message : `OpenAI returned ${response.status}`;
    throw new Error(message);
  }

  const outputText = extractOutputText(data);
  if (!outputText) {
    throw new Error("Model returned no action JSON");
  }

  return JSON.parse(outputText);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        app: "PipeChat",
        model: OPENAI_MODEL,
        freeChatLimit: FREE_CHAT_LIMIT
      });
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const user = await getAuthenticatedUser(req);
      return sendJson(res, 200, { user: user ? publicUser(user) : null });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const email = String(payload.email || "").trim().toLowerCase();
      const password = String(payload.password || "");
      const name = String(payload.name || "").trim();
      if (!email.includes("@") || password.length < 8) {
        return sendJson(res, 400, { error: "Use a valid email and a password with at least 8 characters." });
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
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const email = String(payload.email || "").trim().toLowerCase();
      const password = String(payload.password || "");
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
      const data = await readCrmData(user.id);
      return sendJson(res, 200, data);
    }

    if (req.method === "GET" && url.pathname === "/api/chat-usage") {
      const user = await requireUser(req, res);
      if (!user) return;
      const usage = await readChatUsage(user.id);
      return sendJson(res, 200, usage);
    }

    if (req.method === "PUT" && url.pathname === "/api/crm-data") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      if (!Array.isArray(payload.deals)) {
        return sendJson(res, 400, { error: "Expected { deals: [...] }" });
      }
      const saved = await writeCrmData(user.id, payload.deals);
      return sendJson(res, 200, saved);
    }

    if (req.method === "POST" && url.pathname === "/api/pipechat-ai") {
      const user = await requireUser(req, res);
      if (!user) return;
      const usage = await readChatUsage(user.id);
      if (usage.paymentRequired) {
        return sendJson(res, 402, {
          error: "Free chatbot usage limit reached. Payment is required to continue using the AI chatbot.",
          usage
        });
      }
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      const action = await planPipeChatAction(payload);
      const updatedUsage = await incrementChatUsage(user.id);
      return sendJson(res, 200, { ...action, usage: updatedUsage });
    }

    if (req.method === "GET") {
      return serveStatic(req, res);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(`[PipeChat AI error] ${error.stack || error.message}`);
    return sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PipeChat app running at http://127.0.0.1:${PORT}/`);
  console.log(`PipeChat AI server running at http://127.0.0.1:${PORT}/api/pipechat-ai`);
  console.log(`PipeChat data directory: ${DATA_DIR}`);
  console.log(`Free AI messages per user: ${FREE_CHAT_LIMIT}`);
  console.log(`Model: ${OPENAI_MODEL}`);
});
