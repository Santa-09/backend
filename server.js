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

// ---- Config / Secrets ----
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "santanu@2006";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "santanu@2006";

const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

app.use(cors());
app.use(bodyParser.json());

// ---- In-memory stores ----
let questions = [];
let adminSessions = new Set();
let connections = new Map();

// 🔧 Maintenance state
let maintenanceMode = false;
let maintenanceMessage = "Server under maintenance. Please try again later.";
let maintenanceLogoUrl = "";
let maintenanceUntil = null;
let maintenanceTimer = null;

// ---- Helpers ----
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const conn of connections.keys()) {
    try {
      conn.write(data);
    } catch {}
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!adminSessions.has(decoded.sessionId)) {
      return res.status(401).json({ error: "Invalid session" });
    }
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

function setMaintenance({ status, message, logoUrl, durationMinutes }) {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = null;
  }

  maintenanceMode = !!status;
  if (typeof message === "string" && message.trim()) maintenanceMessage = message.trim();
  if (typeof logoUrl === "string") maintenanceLogoUrl = logoUrl.trim();

  if (maintenanceMode) {
    if (typeof durationMinutes === "number" && durationMinutes > 0) {
      const ms = Math.floor(durationMinutes * 60 * 1000);
      maintenanceUntil = new Date(Date.now() + ms).toISOString();
      maintenanceTimer = setTimeout(() => {
        maintenanceMode = false;
        maintenanceUntil = null;
        maintenanceTimer = null;
        broadcast({ type: "maintenance", payload: currentMaintenancePayload() });
      }, ms);
    } else {
      maintenanceUntil = null;
    }

    const notice = JSON.stringify({ type: "maintenance", payload: currentMaintenancePayload() });
    for (const conn of connections.keys()) {
      try {
        conn.write(notice);
      } catch {}
      try {
        conn.close();
      } catch {}
    }
    connections.clear();
  } else {
    maintenanceUntil = null;
  }

  broadcast({ type: "maintenance", payload: currentMaintenancePayload() });
}

// ---- AI helper ----
async function generateAIReply(prompt) {
  if (!openai) return "AI is not configured on the server.";
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a friendly teaching assistant. Answer clearly in 2–5 short sentences. If the question is vague, give a helpful next step.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    const text =
      resp.choices?.[0]?.message?.content?.trim() ||
      "I’m here! Ask me again with a bit more detail.";
    return text;
  } catch (e) {
    console.error("OpenAI error:", e?.message || e);
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

// ⚠️ FIXED: add trailing slash so frontend matches
sockServer.installHandlers(server, { prefix: "/ws/" });

// ---- Admin auth ----
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

// ---- Maintenance endpoints ----
app.get("/api/admin/maintenance", requireAdmin, (req, res) => {
  res.json(currentMaintenancePayload());
});
app.post("/api/admin/maintenance", requireAdmin, (req, res) => {
  const { status, message, logoUrl, durationMinutes } = req.body || {};
  if (typeof status !== "boolean") return res.status(400).json({ error: "status must be boolean" });
  if (
    durationMinutes !== undefined &&
    !(typeof durationMinutes === "number" && durationMinutes >= 0)
  ) {
    return res.status(400).json({ error: "durationMinutes must be non-negative number" });
  }
  setMaintenance({ status, message, logoUrl, durationMinutes });
  res.json(currentMaintenancePayload());
});

// ---- Members endpoints ----
app.get("/api/members/count", (req, res) => {
  res.json({ totalMembers: connections.size });
});
app.get("/api/admin/members", requireAdmin, (req, res) => {
  res.json({
    totalMembers: connections.size,
    members: Array.from(connections.values()).map((m) => ({ id: m.id, username: m.username })),
  });
});

// ---- Questions ----
app.get("/api/questions", (req, res) => {
  res.json(questions);
});

app.post("/api/questions", async (req, res) => {
  if (maintenanceMode) {
    return res
      .status(503)
      .json({ error: "Server under maintenance", ...currentMaintenancePayload() });
  }
  const { text, user, ai } = req.body || {};
  if (!text || typeof text !== "string")
    return res.status(400).json({ error: "Text is required" });

  const newQuestion = {
    id: uuidv4(),
    text: text.toString().slice(0, 2000),
    user: (user || "anonymous").toString().slice(0, 50),
    createdAt: new Date().toISOString(),
    replies: [],
  };
  questions.push(newQuestion);
  broadcast({ type: "new-question", payload: newQuestion });

  if (ai === true) {
    const aiText = await generateAIReply(text);
    const reply = {
      id: uuidv4(),
      text: aiText,
      user: "AI Assistant",
      createdAt: new Date().toISOString(),
    };
    newQuestion.replies.push(reply);
    broadcast({ type: "new-reply", payload: { questionId: newQuestion.id, reply } });
  }

  res.json(newQuestion);
});

// ---- Replies ----
app.post("/api/questions/:id/replies", async (req, res) => {
  if (maintenanceMode) {
    return res
      .status(503)
      .json({ error: "Server under maintenance", ...currentMaintenancePayload() });
  }
  const { text, user, ai } = req.body || {};
  const question = questions.find((q) => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: "Question not found" });
  if (!text || typeof text !== "string")
    return res.status(400).json({ error: "Text is required" });

  const reply = {
    id: uuidv4(),
    text: text.toString().slice(0, 2000),
    user: (user || "anonymous").toString().slice(0, 50),
    createdAt: new Date().toISOString(),
  };
  question.replies.push(reply);
  broadcast({ type: "new-reply", payload: { questionId: question.id, reply } });

  if (ai === true) {
    const aiText = await generateAIReply(text);
    const aiReply = {
      id: uuidv4(),
      text: aiText,
      user: "AI Assistant",
      createdAt: new Date().toISOString(),
    };
    question.replies.push(aiReply);
    broadcast({ type: "new-reply", payload: { questionId: question.id, reply: aiReply } });
  }

  res.json(reply);
});

// ---- Delete reply (admin) ----
app.delete("/api/questions/:id/replies/:rid", requireAdmin, (req, res) => {
  const question = questions.find((q) => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: "Question not found" });

  const idx = question.replies.findIndex((r) => r.id === req.params.rid);
  if (idx === -1) return res.status(404).json({ error: "Reply not found" });

  const [deleted] = question.replies.splice(idx, 1);
  broadcast({ type: "delete-reply", payload: { questionId: question.id, replyId: deleted.id } });
  res.json({ success: true });
});

// ---- Delete question (admin) ----
app.delete("/api/questions/:id", requireAdmin, (req, res) => {
  const index = questions.findIndex((q) => q.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Not found" });
  const deleted = questions.splice(index, 1)[0];
  broadcast({ type: "delete-question", payload: { id: deleted.id } });
  res.json({ success: true });
});

// ---- Clear all (admin) ----
app.delete("/api/questions", requireAdmin, (req, res) => {
  questions = [];
  broadcast({ type: "clear-all" });
  res.json({ success: true });
});

// ---- start ----
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
