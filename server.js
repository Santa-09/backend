// backend/server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const SockJS = require("sockjs");

const PORT = process.env.PORT || 3001;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "santanu@2006"; // set in Railway variables

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// In-memory data store
const db = {
  questions: [] // { id, text, createdAt, replies: [{ id, text, createdAt }] }
};

// ---- Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ---- Public REST
app.get("/api/questions", (req, res) => {
  const list = [...db.questions].sort((a,b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.post("/api/questions", (req, res) => {
  const text = (req.body && String(req.body.text || "").trim());
  if (!text) return res.status(400).json({ error: "Text is required" });
  const q = { id: uuidv4(), text, createdAt: Date.now(), replies: [] };
  db.questions.push(q);
  broadcast({ type: "question_created", payload: q });
  res.status(201).json(q);
});

app.post("/api/questions/:id/replies", (req, res) => {
  const q = db.questions.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: "Question not found" });
  const text = (req.body && String(req.body.text || "").trim());
  if (!text) return res.status(400).json({ error: "Text is required" });
  const r = { id: uuidv4(), text, createdAt: Date.now() };
  q.replies.push(r);
  broadcast({ type: "reply_added", payload: { questionId: q.id, reply: r } });
  res.status(201).json(r);
});

// ---- Admin auth (very simple token-based)
const adminSessions = new Set();

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_SECRET) return res.status(500).json({ error: "ADMIN_SECRET not set on server" });
  if (password !== ADMIN_SECRET) return res.status(401).json({ error: "Invalid password" });
  const token = uuidv4();
  adminSessions.add(token);
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---- Admin actions
// Delete a question
app.delete("/api/questions/:id", requireAdmin, (req, res) => {
  const idx = db.questions.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Question not found" });
  const [removed] = db.questions.splice(idx, 1);
  broadcast({ type: "question_deleted", payload: { id: removed.id } });
  res.json({ ok: true });
});

// Delete a single reply
app.delete("/api/questions/:id/replies/:rid", requireAdmin, (req, res) => {
  const q = db.questions.find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ error: "Question not found" });
  const rIdx = q.replies.findIndex(r => r.id === req.params.rid);
  if (rIdx === -1) return res.status(404).json({ error: "Reply not found" });
  const [removed] = q.replies.splice(rIdx, 1);
  broadcast({ type: "reply_deleted", payload: { questionId: q.id, replyId: removed.id } });
  res.json({ ok: true });
});

// Clear all questions + replies
app.post("/api/admin/clear", requireAdmin, (req, res) => {
  db.questions = [];
  broadcast({ type: "cleared" });
  res.json({ ok: true });
});

// ---- SockJS real-time hub
const sockServer = SockJS.createServer({ prefix: "/ws" });
const connections = new Set();
sockServer.on("connection", (conn) => {
  connections.add(conn);
  conn.write(JSON.stringify({ type: "connected", payload: { message: "Welcome" }}));
  conn.on("close", () => connections.delete(conn));
});

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const c of connections) {
    try { c.write(data); } catch {}
  }
}

const server = http.createServer(app);
sockServer.installHandlers(server);
server.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`➡ SockJS endpoint: /ws`);
});
