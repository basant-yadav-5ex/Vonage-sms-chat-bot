import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

/* ================= ENV ================= */
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= STATIC UI ================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

/* ================= HELPERS ================= */
function normalizeNumber(input) {
  const digits = (input || "").toString().replace(/[^\d]/g, "");
  return digits.length === 10 ? "1" + digits : digits;
}

function nowMs() {
  return Date.now();
}

function safeText(payload) {
  return payload?.text || payload?.message?.content?.text || "";
}

/* ================= ENV VALIDATION ================= */
const VONAGE_API_KEY = process.env.VONAGE_API_KEY;
const VONAGE_API_SECRET = process.env.VONAGE_API_SECRET;
const VONAGE_FROM = process.env.VONAGE_FROM;

if (!VONAGE_API_KEY || !VONAGE_API_SECRET || !VONAGE_FROM) {
  console.error("❌ Missing Vonage env vars");
  process.exit(1);
}

/* ================= THREAD STORE ================= */
// key = bot number
const threads = new Map();

function getThread(key) {
  if (!threads.has(key)) threads.set(key, []);
  return threads.get(key);
}

function addMessage(key, msg) {
  const t = getThread(key);
  t.push(msg);
  t.sort((a, b) => a.ts - b.ts);
  if (t.length > 500) t.splice(0, t.length - 500);
}

/* ================= CONCAT BUFFER ================= */
const concatBuffer = new Map();
const CONCAT_TIMEOUT = 60000;

function handleConcatenatedSms(payload) {
  const ref = payload["concat-ref"];
  const part = parseInt(payload["concat-part"] || "1");
  const total = parseInt(payload["concat-total"] || "1");
  const text = safeText(payload);

  if (!ref || total === 1) return text;

  if (!concatBuffer.has(ref)) {
    concatBuffer.set(ref, {
      parts: new Map(),
      total,
      ts: Date.now()
    });

    setTimeout(() => concatBuffer.delete(ref), CONCAT_TIMEOUT);
  }

  const buf = concatBuffer.get(ref);
  buf.parts.set(part, text);

  if (buf.parts.size === total) {
    const combined = Array.from({ length: total })
      .map((_, i) => buf.parts.get(i + 1) || "")
      .join("");
    concatBuffer.delete(ref);
    return combined;
  }

  return null;
}

/* ================= SEND SMS ================= */
async function sendSms({ to, text }) {
  return axios.post("https://rest.nexmo.com/sms/json", {
    api_key: VONAGE_API_KEY,
    api_secret: VONAGE_API_SECRET,
    from: VONAGE_FROM,
    to,
    text
  });
}

/* ================= API: THREAD ================= */
app.get("/api/chat/thread", (req, res) => {
  const key = normalizeNumber(req.query.with || "");
  if (!key) return res.status(400).json({ ok: false });

  res.json({
    ok: true,
    with: key,
    messages: getThread(key)
  });
});

/* ================= API: SEND ================= */
app.post("/api/chat/send", async (req, res) => {
  const key = normalizeNumber(req.body.to || "");
  const text = (req.body.text || "").trim();
  if (!key || !text) return res.status(400).json({ ok: false });

  const msg = {
    id: `out_${nowMs()}`,
    dir: "out",
    text,
    ts: nowMs()
  };

  addMessage(key, msg);

  // 🔥 notify WS
  req.app.get("notifyWs")?.(key, msg);

  await sendSms({ to: key, text });

  res.json({ ok: true });
});

/* ================= VONAGE INBOUND ================= */
app.all("/api/vonage/inbound-sms", (req, res) => {
  const payload = { ...req.query, ...req.body };
  const from = normalizeNumber(payload.msisdn);
  const to = normalizeNumber(payload.to);

  const fullText = handleConcatenatedSms(payload);
  if (!fullText) return res.send("ok");

  if (to === VONAGE_FROM && from) {
    const msg = {
      id: `in_${nowMs()}`,
      dir: "in",
      text: fullText,
      ts: nowMs()
    };

    addMessage(from, msg);

    // 🔥 notify WS
    req.app.get("notifyWs")?.(from, msg);
  }

  res.send("ok");
});

/* ================= DLR ================= */
app.all("/sms/status", (req, res) => {
  res.send("ok");
});

/* ================= EXPORT ================= */
export default app;
