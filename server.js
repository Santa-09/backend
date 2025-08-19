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
const JWT_SECRET = process.env.JWT_SECRET || "santanu@2006";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "santanu@2006";

// ---- OpenAI ----
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

// ---- Middleware ----
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5000",
    "https://frontend-ten-tan-10.vercel.app"   // ✅ your Vercel frontend
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));
app.use(bodyParser.json());

// ---- In-memory storage ----
let questions = [];
let adminSessions = new Set();
let connections = new Map();

// ---- Maintenance state ----
let maintenanceMode = false;
let maintenanceMessage = "Server under maintenance. Please try again later.";
let maintenanceLogoUrl = "";
let maintenanceUntil = null;

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
  if (!openai) return "⚠️ AI is not configured on the server.";
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a friendly assistant. Answer clearly in 2–5 short sentences." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3
    });
    return resp.choices?.[0]?.message?.content?.trim() || "I couldn’t generate an answer.";
  } catch (err) {
    console.error("OpenAI error:", err);
    return "Sorry, I couldn’t generate an answer right now.";
  }
}

// ---- SockJS ----
sockServer.on("connection", (conn) => {
  const member = { id: uuidv4(), username: null };
  connections.set(conn, member);

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

// ⚠️ Important: must end with `/`
sockServer.installHandlers(server, { prefix: "/ws/" });

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

// ---- Start server ----
server.listen(PORT, () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});
