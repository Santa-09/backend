import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";
import { createServer } from "http";
import sockjs from "sockjs";

const app = express();
const server = createServer(app);
const sockServer = sockjs.createServer();

const PORT = process.env.PORT || 5000;
const JWT_SECRET = "santanu@2006"; // keep safe!
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "santanu@2006";

app.use(cors());
app.use(bodyParser.json());

// In-memory stores
let questions = []; // {id, text, createdAt, user, replies:[{id,text,createdAt,user}]}
let adminSessions = new Set();
let connections = new Map(); // Map<conn, {id, username}>

// 🔧 Maintenance state
let maintenanceMode = false;
let maintenanceMessage = "Server under maintenance. Please try again later.";
let maintenanceLogoUrl = "";
let maintenanceUntil = null;
let maintenanceTimer = null;

// ---- Helpers ----
function broadcast(message, { exclude } = {}) {
  const data = JSON.stringify(message);
  for (const conn of connections.keys()) {
    if (exclude && conn === exclude) continue;
    try { conn.write(data); } catch {}
  }
}
function currentMaintenancePayload() {
  return { status: maintenanceMode, message: maintenanceMessage, logoUrl: maintenanceLogoUrl, until: maintenanceUntil };
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
function setMaintenance({ status, message, logoUrl, durationMinutes }) {
  if (maintenanceTimer) { clearTimeout(maintenanceTimer); maintenanceTimer = null; }
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
      try { conn.write(notice); } catch {}
      try { conn.close(); } catch {}
    }
    connections.clear();
  } else {
    maintenanceUntil = null;
  }
  broadcast({ type: "maintenance", payload: currentMaintenancePayload() });
}

// ---- SockJS ----
sockServer.on("connection", (conn) => {
  const member = { id: uuidv4(), username: null };
  connections.set(conn, member);

  // Send current maintenance state immediately
  conn.write(JSON.stringify({ type: "maintenance", payload: currentMaintenancePayload() }));

  conn.on("data", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "set-username") {
        member.username = data.username || "Guest";
        // optional: broadcast join/leave
        broadcast({ type: "user-joined", payload: { id: member.id, username: member.username } }, { exclude: conn });
      } else if (data.type === "typing") {
        // Fan-out typing events to others
        const payload = {
          questionId: data.questionId || null,
          username: member.username || data.username || "Someone"
        };
        broadcast({ type: "typing", payload }, { exclude: conn });
      }
    } catch {}
  });

  conn.on("close", () => {
    connections.delete(conn);
    broadcast({ type: "user-left", payload: member });
  });
});
sockServer.installHandlers(server, { prefix: "/ws" });

// ---- Admin auth ----
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const sessionId = uuidv4();
    adminSessions.add(sessionId);
    const token = jwt.sign({ username, sessionId }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// ---- Maintenance endpoints (admin only) ----
app.get("/api/admin/maintenance", requireAdmin, (req, res) => {
  res.json(currentMaintenancePayload());
});
app.post("/api/admin/maintenance", requireAdmin, (req, res) => {
  const { status, message, logoUrl, durationMinutes } = req.body || {};
  if (typeof status !== "boolean") return res.status(400).json({ error: "status must be boolean" });
  if (durationMinutes !== undefined && !(typeof durationMinutes === "number" && durationMinutes >= 0)) {
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
app.post("/api/questions", (req, res) => {
  if (maintenanceMode) {
    return res.status(503).json({ error: "Server under maintenance", ...currentMaintenancePayload() });
  }
  const { text, user } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });

  const newQuestion = {
    id: uuidv4(),
    text,
    createdAt: new Date().toISOString(),
    user: user || null,
    replies: [],
  };
  questions.push(newQuestion);
  broadcast({ type: "new-question", payload: newQuestion });
  res.json(newQuestion);
});

// ---- Replies ----
app.post("/api/questions/:id/replies", (req, res) => {
  if (maintenanceMode) {
    return res.status(503).json({ error: "Server under maintenance", ...currentMaintenancePayload() });
  }
  const { text, user } = req.body;
  const question = questions.find((q) => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: "Question not found" });
  if (!text) return res.status(400).json({ error: "Text is required" });

  const reply = { id: uuidv4(), text, createdAt: new Date().toISOString(), user: user || null };
  question.replies.push(reply);
  broadcast({ type: "new-reply", payload: { questionId: question.id, reply } });
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
