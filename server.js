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
const JWT_SECRET = "santanu@2006"; // secret for signing JWT tokens
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";

// middleware
app.use(cors());
app.use(bodyParser.json());

// in-memory stores
let questions = []; // {id, text, createdAt, replies:[{id,text,createdAt}]}
let adminSessions = new Set();
let connections = new Set();

// JWT middleware for admin routes
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
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ---- SockJS setup ----
sockServer.on("connection", (conn) => {
  connections.add(conn);
  conn.id = uuidv4(); // assign unique ID to each member

  conn.on("data", () => { /* no-op */ });

  conn.on("close", () => {
    connections.delete(conn);
  });
});

sockServer.installHandlers(server, { prefix: "/ws" });

// ---- API Routes ----

// Admin login (expects { username, password })
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const sessionId = uuidv4();
    adminSessions.add(sessionId);
    const token = jwt.sign({ username, sessionId }, JWT_SECRET, {
      expiresIn: "1h",
    });
    res.json({ token });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

// Get all questions
app.get("/api/questions", (req, res) => {
  res.json(questions);
});

// Add a new question
app.post("/api/questions", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Text is required" });

  const newQuestion = {
    id: uuidv4(),
    text,
    createdAt: new Date().toISOString(),
    replies: [],
  };
  questions.push(newQuestion);

  // broadcast to all connections
  broadcast({ type: "new-question", payload: newQuestion });

  res.json(newQuestion);
});

// Add a reply
app.post("/api/questions/:id/replies", (req, res) => {
  const { text } = req.body;
  const question = questions.find((q) => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: "Question not found" });
  if (!text) return res.status(400).json({ error: "Text is required" });

  const reply = { id: uuidv4(), text, createdAt: new Date().toISOString() };
  question.replies.push(reply);

  broadcast({ type: "new-reply", payload: { questionId: question.id, reply } });

  res.json(reply);
});

// Delete a reply (admin only)
app.delete("/api/questions/:id/replies/:rid", requireAdmin, (req, res) => {
  const question = questions.find((q) => q.id === req.params.id);
  if (!question) return res.status(404).json({ error: "Question not found" });

  const idx = question.replies.findIndex((r) => r.id === req.params.rid);
  if (idx === -1) return res.status(404).json({ error: "Reply not found" });

  const [deleted] = question.replies.splice(idx, 1);

  broadcast({
    type: "delete-reply",
    payload: { questionId: question.id, replyId: deleted.id },
  });

  res.json({ success: true });
});

// Delete a question (admin only)
app.delete("/api/questions/:id", requireAdmin, (req, res) => {
  const index = questions.findIndex((q) => q.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Not found" });

  const deleted = questions.splice(index, 1)[0];

  broadcast({ type: "delete-question", payload: { id: deleted.id } });

  res.json({ success: true });
});

// Clear all questions (admin only)
app.delete("/api/questions", requireAdmin, (req, res) => {
  questions = [];
  broadcast({ type: "clear-all" });
  res.json({ success: true });
});

// ---- Members endpoints ----

// Anyone can see just count
app.get("/api/members/count", (req, res) => {
  res.json({ totalMembers: connections.size });
});

// Admin can see details
app.get("/api/admin/members", requireAdmin, (req, res) => {
  res.json({
    totalMembers: connections.size,
    members: Array.from(connections).map((c) => ({ id: c.id })),
  });
});

// ---- Broadcast helper ----
function broadcast(message) {
  const data = JSON.stringify(message);
  connections.forEach((conn) => {
    try {
      conn.write(data);
    } catch {}
  });
}

// start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
