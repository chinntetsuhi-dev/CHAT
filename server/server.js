import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

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

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

/** 在线房间：Map<roomId, Set<ws>> */
const rooms = new Map();
/** 历史房间：Set<roomId>（进程内记忆，不删） */
const allRooms = new Set();
/** 最近活跃时间：Map<roomId, ts> */
const roomUpdated = new Map();

/** 给房间打点更新时间 */
function touch(roomId) {
  roomUpdated.set(roomId, Date.now());
}

/** 群发 */
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

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * 房间列表 API
 * GET /api/rooms?scope=active|all  （默认 active）
 * 返回已按最近活跃降序排好序的房间 ID 数组
 */
app.get("/api/rooms", (req, res) => {
  const scope = String(req.query.scope || "active");
  let list;
  if (scope === "all") {
    list = Array.from(allRooms);
  } else {
    list = Array.from(rooms.entries())
      .filter(([_, set]) => set && set.size > 0)
      .map(([roomId]) => roomId);
  }
  list.sort((a, b) => (roomUpdated.get(b) || 0) - (roomUpdated.get(a) || 0));
  res.json(list);
});

wss.on("connection", (ws) => {
  // 每条连接的元信息
  const meta = { id: randomUUID(), room: null, name: "Anonymous" };
  ws._meta = meta;

  ws.on("message", (buf) => {
    const msg = safeJson(buf.toString());
    if (!msg) return;

    // ---- 加入房间 ----
    if (msg.type === "join") {
      const roomId = String(msg.room || "").slice(0, 64);
      const name = String(msg.name || "Anonymous").slice(0, 32);

      if (!roomId) {
        ws.send(JSON.stringify({ type: "error", reason: "invalid_room" }));
        return;
      }

      // 离开旧房间
      if (meta.room && rooms.has(meta.room)) {
        const oldSet = rooms.get(meta.room);
        oldSet.delete(ws);
        if (oldSet.size === 0) rooms.delete(meta.room); // 允许 active 清空
      }

      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const set = rooms.get(roomId);

      // 1v1 限制
      if (set.size >= 2) {
        ws.send(JSON.stringify({ type: "error", reason: "room_full" }));
        ws.close(1008, "Room full");
        return;
      }

      // 写元信息、集合
      set.add(ws);
      meta.room = roomId;
      meta.name = name;

      // 记录到历史集合，并打点活跃时间
      allRooms.add(roomId);
      touch(roomId);

      // 回执与广播
      ws.send(JSON.stringify({ type: "joined", room: roomId, you: name }));
      broadcast(roomId, { type: "system", text: `${name} 加入了房间` }, ws);
      return;
    }

    // ---- 发消息 ----
    if (msg.type === "msg") {
      if (!meta.room) return;
      const text = String(msg.text || "").trim();
      if (!text || text.length > 2000) return;

      const payload = { type: "msg", name: meta.name, text, ts: Date.now() };
      // 回显给自己（前端根据 name===me 做渲染）
      ws.send(JSON.stringify(payload));
      // 发给对方
      broadcast(meta.room, payload, ws);
      // 活跃时间
      touch(meta.room);
      return;
    }
  });

  ws.on("close", () => {
    const m = ws._meta;
    if (m?.room && rooms.has(m.room)) {
      const set = rooms.get(m.room);
      set.delete(ws);
      if (set.size === 0) {
        rooms.delete(m.room); // 只从“在线集合”里删，不删 allRooms
      } else {
        broadcast(m.room, { type: "system", text: `${m.name} 离开了房间` });
      }
      touch(m.room);
    }
  });

  // 心跳
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
