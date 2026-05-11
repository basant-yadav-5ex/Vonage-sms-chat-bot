import dotenv from "dotenv";
dotenv.config({ quiet: true });

import http from "http";
import { WebSocketServer } from "ws";
import app, { normalizeNumber } from "./server.js";

const server = http.createServer(app);

/* ===== WebSocket state ===== */
const subscriptions = new Map(); // botNumber -> Set(ws)

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔌 WS connected");

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "subscribe") {
      const key = String(msg.with ?? "").trim();

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
  const k = String(key ?? "").trim();
  console.log("WS notify key:", k);

  const clients = subscriptions.get(k);

  if (!clients) {
    console.log(
      "⚠️ No WS subscribers for",
      k,
      "— inbound SMS was stored but no browser tab has a live WebSocket. Open http://localhost:" +
        (process.env.PORT || 3000) +
        "/ (or your ngrok URL) with the chat loaded so replies appear in the UI."
    );
    return;
  }

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: "message",
        data: message
      }));
    }
  }
});

const PORT = Number(process.env.PORT) || 3000;
const baseUrl = String(process.env.BASE_URL || "").trim().replace(/\/$/, "");

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use (another npm start / IDE / ngrok upstream?).\n`);
    console.error("Free it, or use a different port: set PORT=3001 in .env then restart.\n");
    console.error("PowerShell — find PID listening on this port:");
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess`);
    console.error("Then stop it (replace <PID>):");
    console.error("  Stop-Process -Id <PID> -Force\n");
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("");
  const fromRaw = String(process.env.VONAGE_FROM || process.env.VONAGE_VIRTUAL_NUMBER || "").trim();
  const fromKey = normalizeNumber(fromRaw);
  console.log(
    "Vonage LVN (VONAGE_FROM / VONAGE_VIRTUAL_NUMBER):",
    fromRaw || "(unset)",
    "→ normalized:",
    fromKey || "(empty)"
  );
  console.log(
    "  In Vonage Dashboard, set the SMS inbound webhook on THIS number (the line people text when they reply to you)."
  );
  console.log("");
  console.log("Vonage uses two different callbacks (both must point at this app if you want replies in the UI):");
  console.log("  • Inbound SMS (customer → your number) → set on the NUMBER in Dashboard:");
  console.log(`      …/api/vonage/inbound-sms`);
  console.log("  • Delivery receipts (DLR, status of sends) → often /sms/status only:");
  console.log(`      …/sms/status`);
  console.log("");
  if (baseUrl) {
    console.log("From BASE_URL in .env, Vonage should call:");
    console.log(`  ${baseUrl}/api/vonage/inbound-sms`);
    console.log(`  ${baseUrl}/sms/status`);
    console.log("If inbound still never hits the server, run: npm run sync:vonage-webhooks");
    console.log("(or set the same URLs on your Vonage API Application if the number is linked to Messages API).");
    console.log("");
  }
  console.log(
    "If ngrok only shows POST /sms/status, inbound is not configured — you will not see replies in chat."
  );
  console.log("While ngrok runs: npm run inspect:ngrok-inbound — lists recent /api/vonage/inbound-sms and /sms/status hits.");
  console.log("");
});
