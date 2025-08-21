import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";
import { createServer } from "http";
import sockjs from "sockjs";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const server = createServer(app);
const sockServer = sockjs.createServer();

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// ---- OpenAI ----
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

// ---- Middleware ----
app.use(cors({
  origin: [
    /localhost:\d+$/,            // any localhost port
    "http://localhost:3000",
    "http://localhost:5000",
    "https://frontend-ten-tan-10.vercel.app",
    /\.vercel\.app$/,
    /\.railway\.app$/
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));
app.use(bodyParser.json());

// Health
app.get("/api/health", (req, res) => {
  res.json({ ok: true, maintenance: currentMaintenancePayload() });
});

// ---- In-memory storage ----
let questions = [];
let adminSessions = new Set();
let connections = new Map(); // Map<conn, {id, username}>

// ---- Maintenance state ----
let maintenanceMode = false;
let maintenanceMessage = "Server under maintenance. Please try again later.";
let maintenanceLogoUrl = "";
let maintenanceUntil = null; // ISO string or null

// ---- Helpers ----
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const conn of connections.keys()) {
    try { conn.write(data); } catch {}
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!adminSessions.has(decoded.sessionId)) return res.status(401).json({ error: "Invalid session" });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function currentMaintenancePayload() {
  return {
    status: maintenanceMode,
    message: maintenanceMessage,
    logoUrl: maintenanceLogoUrl,
    until: maintenanceUntil,
  };
}

// ---- AI helper ----
async function generateAIReply(prompt) {
  if (!openai) {
    console.warn("OPENAI_API_KEY missing; AI disabled.");
    return "⚠️ AI is not configured on the server.";
  }

  // models to try in order
  const models = "gpt-4o";

  for (const model of models) {
    try {
      const resp = await openai.chat.completions.create({
        model,
        messages: [
          { role: "system", content: "You are a friendly assistant. Answer clearly in 2–5 short sentences." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
      });
      const text = resp.choices?.[0]?.message?.content?.trim();
      if (text) {
        console.log(`✅ Reply generated with model: ${model}`);
        return text;
      }
    } catch (err) {
      console.error(`❌ Error with ${model}:`, err?.response?.data || err.message || err);
    }
  }

  return "⚠️ Sorry, I couldn’t generate an answer right now.";
}


// ---- SockJS ----
sockServer.on("connection", (conn) => {
  const member = { id: uuidv4(), username: null };
  connections.set(conn, member);

  // Send current maintenance state on connect
  conn.write(JSON.stringify({ type: "maintenance", payload: currentMaintenancePayload() }));

  conn.on("data", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "set-username") {
        member.username = (data.username || "Guest").toString().slice(0, 50);
        broadcast({ type: "user-joined", payload: { id: member.id, username: member.username } });
      }
    } catch {}
  });

  conn.on("close", () => {
    connections.delete(conn);
    broadcast({ type: "user-left", payload: { id: member.id, username: member.username } });
  });
});

// Prefix without trailing slash
sockServer.installHandlers(server, { prefix: "/ws" });

// ---- Admin login ----
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const sessionId = uuidv4();
    adminSessions.add(sessionId);
    const token = jwt.sign({ username, sessionId }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// ---- Admin: members list ----
app.get("/api/admin/members", requireAdmin, (req, res) => {
  const list = [];
  for (const [, m] of connections) list.push({ username: m.username || "Guest", online: true });
  res.json(list);
});

// ---- Admin: maintenance ----
app.get("/api/admin/maintenance", requireAdmin, (req, res) => {
  res.json(currentMaintenancePayload());
});

app.put("/api/admin/maintenance", requireAdmin, (req, res) => {
  const { status, message, logoUrl, until } = req.body || {};
  maintenanceMode = !!status;
  if (typeof message === "string") maintenanceMessage = message.slice(0, 300);
  if (typeof logoUrl === "string") maintenanceLogoUrl = logoUrl.slice(0, 500);
  maintenanceUntil = until || null;

  const payload = currentMaintenancePayload();
  broadcast({ type: "maintenance", payload });
  res.json(payload);
});

app.delete("/api/admin/maintenance", requireAdmin, (req, res) => {
  maintenanceMode = false;
  maintenanceMessage = "";
  maintenanceLogoUrl = "";
  maintenanceUntil = null;
  const payload = currentMaintenancePayload();
  broadcast({ type: "maintenance", payload });
  res.json({ ok: true });
});

// ---- Admin: clear all ----
app.delete("/api/admin/clear-all", requireAdmin, (req, res) => {
  questions = [];
  broadcast({ type: "clear-all" });
  res.json({ ok: true });
});

// ---- Questions ----
app.get("/api/questions", (req, res) => res.json(questions));

app.post("/api/questions", async (req, res) => {
  if (maintenanceMode) return res.status(503).json({ error: "Server under maintenance", ...currentMaintenancePayload() });

  const { text, user, ai } = req.body || {};
  if (!text) return res.status(400).json({ error: "Text is required" });

  const newQuestion = {
    id: uuidv4(),
    text: text.slice(0, 2000),
    user: (user || "anonymous").slice(0, 50),
    createdAt: new Date().toISOString(),
    replies: []
  };
  questions.push(newQuestion);
  broadcast({ type: "new-question", payload: newQuestion });

  if (ai === true) {
    const replyText = await generateAIReply(text);
    const reply = { id: uuidv4(), text: replyText, user: "AI Assistant", createdAt: new Date().toISOString() };
    newQuestion.replies.push(reply);
    broadcast({ type: "new-reply", payload: { questionId: newQuestion.id, reply } });
  }

  res.json(newQuestion);
});

// ---- Replies ----
app.post("/api/questions/:id/replies", async (req, res) => {
  if (maintenanceMode) return res.status(503).json({ error: "Server under maintenance", ...currentMaintenancePayload() });

  const { text, user, ai } = req.body || {};
  const question = questions.find((q) => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: "Question not found" });
  if (!text) return res.status(400).json({ error: "Text is required" });

  const reply = {
    id: uuidv4(),
    text: text.slice(0, 2000),
    user: (user || "anonymous").slice(0, 50),
    createdAt: new Date().toISOString()
  };
  question.replies.push(reply);
  broadcast({ type: "new-reply", payload: { questionId: question.id, reply } });

  if (ai === true) {
    const replyText = await generateAIReply(text);
    const aiReply = { id: uuidv4(), text: replyText, user: "AI Assistant", createdAt: new Date().toISOString() };
    question.replies.push(aiReply);
    broadcast({ type: "new-reply", payload: { questionId: question.id, reply: aiReply } });
  }

  res.json(reply);
});

// ---- Delete endpoints ----
app.delete("/api/questions/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const idx = questions.findIndex((q) => q.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  questions.splice(idx, 1);
  broadcast({ type: "delete-question", payload: { id } });
  res.json({ ok: true });
});

app.delete("/api/questions/:qid/replies/:rid", requireAdmin, (req, res) => {
  const { qid, rid } = req.params;
  const q = questions.find((x) => x.id === qid);
  if (!q) return res.status(404).json({ error: "Question not found" });
  const i = q.replies.findIndex((r) => r.id === rid);
  if (i === -1) return res.status(404).json({ error: "Reply not found" });
  q.replies.splice(i, 1);
  broadcast({ type: "delete-reply", payload: { questionId: qid, replyId: rid } });
  res.json({ ok: true });
});

// ---- Start server ----
server.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
