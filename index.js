import dotenv from "dotenv";
dotenv.config({ quiet: true });

import http from "http";
import { WebSocketServer } from "ws";
import app from "./server.js";

const server = http.createServer(app);

/* ===== WebSocket state ===== */
const subscriptions = new Map(); // botNumber -> Set(ws)

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 WS connected");

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "subscribe") {
      const key = msg.with;

      if (!subscriptions.has(key)) {
        subscriptions.set(key, new Set());
      }

      subscriptions.get(key).add(ws);
      ws._key = key;

      console.log("📡 WS subscribed:", key);
    }
  });

  ws.on("close", () => {
    if (ws._key) {
      subscriptions.get(ws._key)?.delete(ws);
    }
  });
});

/* ===== expose notify to Express ===== */
app.set("notifyWs", (key, message) => {
  const clients = subscriptions.get(key);
  if (!clients) return;

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: "message",
        data: message
      }));
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
