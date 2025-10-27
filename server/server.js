import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { randomUUID, randomBytes } from "crypto";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_, res) => {
  res.type("text/plain").send("Retro 1v1 Chat WS server is running.");
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log("HTTP server on", port);
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server });

/** rooms: { [roomId]: Set<ws> } */
const rooms = new Map();
/** meta for each ws: { id, name, room } */
const meta = new WeakMap();

function broadcast(roomId, payload, exceptWs) {
  const set = rooms.get(roomId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const client of set) {
    if (client.readyState === 1 && client !== exceptWs) {
      client.send(data);
    }
  }
}

function safeJson(str) { try { return JSON.parse(str); } catch { return null; } }

// --- 新增：房间列表 API（给大厅用） ---
app.get("/api/rooms", (_req, res) => {
  // 只返回“当前有人连接”的活跃房间 ID
  const list = Array.from(rooms.entries())
    .filter(([_, set]) => set && set.size > 0)
    .map(([roomId]) => roomId);
  res.json(list);
});

wss.on("connection", (ws) => {
  meta.set(ws, { id: randomUUID(), room: null, name: "Anonymous" });

  ws.on("message", (buf) => {
    const msg = safeJson(buf.toString());
    if (!msg) return;

    if (msg.type === "join") {
      const roomId = String(msg.room || "").slice(0, 64);
      const name = String(msg.name || "Anonymous").slice(0, 32);

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const set = rooms.get(roomId);

      // 限 2 人
      if (set.size >= 2) {
        ws.send(JSON.stringify({ type: "error", reason: "room_full" }));
        ws.close(1008, "Room full");
        return;
      }

      // 迁移：如果之前在别的房间，先移除
      const m = meta.get(ws);
      if (m.room && rooms.has(m.room)) {
        rooms.get(m.room).delete(ws);
        if (rooms.get(m.room).size === 0) rooms.delete(m.room);
      }

      set.add(ws);
      meta.set(ws, { ...m, room: roomId, name });

      ws.send(JSON.stringify({ type: "joined", room: roomId, you: name }));
      broadcast(roomId, { type: "system", text: `${name} 加入了房间` }, ws);
      return;
    }

    if (msg.type === "msg") {
      const m = meta.get(ws);
      if (!m?.room) return;
      const text = String(msg.text || "").trim();
      if (!text || text.length > 2000) return;

      const payload = {
        type: "msg",
        name: m.name,
        text,
        ts: Date.now()
      };
      // 回显给自己 + 发给对方
      ws.send(JSON.stringify(payload));
      broadcast(m.room, payload, ws);
      return;
    }
  });

  ws.on("close", () => {
    const m = meta.get(ws);
    if (m?.room && rooms.has(m.room)) {
      const set = rooms.get(m.room);
      set.delete(ws);
      if (set.size === 0) rooms.delete(m.room);
      else broadcast(m.room, { type: "system", text: `${m.name} 离开了房间` });
    }
  });

  // 心跳，避免闲置断开
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

// 心跳定时器
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

wss.on("close", () => clearInterval(interval));
