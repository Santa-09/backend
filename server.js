// backend/server.js
// Anonymous Classroom Q&A - Backend (Express + SockJS)
// Ready for Railway (PORT from env) and local dev.

const express = require("express");
const http = require("http");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const SockJS = require("sockjs");

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json());

// In-memory data store
const db = {
  questions: [] // { id, text, createdAt, replies: [{ id, text, createdAt }] }
};

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// REST: list questions (most recent first)
app.get("/api/questions", (req, res) => {
  const list = [...db.questions].sort((a,b) => b.createdAt - a.createdAt);
  res.json(list);
});

// REST: create question
app.post("/api/questions", (req, res) => {
  const text = (req.body && String(req.body.text || "").trim());
  if (!text) return res.status(400).json({ error: "Text is required" });
  const q = { id: uuidv4(), text, createdAt: Date.now(), replies: [] };
  db.questions.push(q);
  broadcast({ type: "question_created", payload: q });
  res.status(201).json(q);
});

// REST: add reply to a question
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

// --- SockJS real-time hub ---
const sockServer = SockJS.createServer({ prefix: "/ws" });
const connections = new Set();
sockServer.on('connection', (conn) => {
  connections.add(conn);
  conn.write(JSON.stringify({ type: "connected", payload: { message: "Welcome" }}));

  conn.on('close', () => {
    connections.delete(conn);
  });
});

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const c of connections) {
    try { c.write(data); } catch (e) {}
  }
}

const server = http.createServer(app);
sockServer.installHandlers(server);
server.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`➡ SockJS endpoint: /ws`);
});
