import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { sendSms } from "./vonageSend.js";

/* ================= ENV ================= */
dotenv.config({ quiet: true });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= STATIC UI ================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

/* ================= HELPERS ================= */
export function normalizeNumber(input) {
  const digits = (input || "").toString().replace(/[^\d]/g, "");
  return digits.length === 10 ? "1" + digits : digits;
}

function formatPhoneDisplay(key) {
  if (!key) return "";
  const d = String(key).replace(/\D/g, "");
  return d ? d : "";
}

function nowMs() {
  return Date.now();
}

let messageSeq = 0;

function nextMessageMeta(dir) {
  messageSeq += 1;
  const ts = nowMs();
  return {
    id: `${dir}_${ts}_${messageSeq}`,
    ts,
    seq: messageSeq
  };
}

function firstStr(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[v.length - 1] ?? "");
  return String(v);
}

function safeText(payload) {
  const c = payload?.message?.content;
  const inner = payload?.message;
  let fromContentArray = "";
  if (Array.isArray(c) && c[0] && typeof c[0] === "object") {
    fromContentArray = firstStr(c[0].text) || firstStr(c[0].body) || "";
  }
  const t =
    firstStr(payload?.text) ||
    firstStr(payload?.body) ||
    firstStr(c?.text) ||
    firstStr(c?.body) ||
    fromContentArray ||
    (typeof inner === "object" && inner ? firstStr(inner.text) : "") ||
    "";
  return t.trim() === "" ? "" : t;
}

/**
 * Classic SMS API: flat { msisdn, to, text }.
 * Messages API (Vonage Application “Messages” inbound URL): nested
 * { from: { type, number }, to: { type, number }, message: { content: { type, text } } }.
 * Normalize so safeText, concat handling, and logs behave the same for both.
 */
function normalizeInboundSmsPayload(raw) {
  if (!raw || typeof raw !== "object") return {};
  const p = { ...raw };

  if (p.msisdn != null && p.msisdn !== "") {
    p.msisdn = normalizeNumber(firstStr(p.msisdn)) || String(firstStr(p.msisdn)).replace(/\D/g, "");
  }

  if (p.from && typeof p.from === "object" && p.from.number != null && !p.msisdn) {
    const fn = firstStr(p.from.number);
    p.msisdn = normalizeNumber(fn) || String(fn).replace(/\D/g, "");
  }

  if (p.to && typeof p.to === "object" && p.to.number != null) {
    p.to = String(p.to.number);
  }

  const content = p.message?.content;
  if (Array.isArray(content) && content[0] && typeof content[0] === "object") {
    const z = content[0];
    if (z.text != null && !p.text) p.text = z.text;
    if (z.body != null && !p.text) p.text = z.body;
  } else if (content && typeof content === "object") {
    if (content.text != null && !p.text) p.text = content.text;
    if (content.body != null && !p.text) p.text = content.body;
  }

  return p;
}

function senderKeyFromInboundPayload(p) {
  if (!p) return "";
  if (p.msisdn != null && String(p.msisdn).trim() !== "") {
    return normalizeNumber(firstStr(p.msisdn));
  }
  if (p.from && typeof p.from === "object" && p.from.number != null) {
    return normalizeNumber(firstStr(p.from.number));
  }
  if (p.from != null && typeof p.from !== "object") return normalizeNumber(firstStr(p.from));
  return "";
}

/* ================= TEST / VALIDATION HOOKS ================= */
const inboundWaiters = new Set();
const dlrWaiters = new Set();

/** Wait until an inbound SMS webhook is received whose sender matches `fromNumber` (digits / E.164). Requires the HTTP server (e.g. index.js) to be running and Vonage inbound URL pointing at /api/vonage/inbound-sms. */
export function waitForInboundFrom({ fromNumber, timeoutMs = 30000 }) {
  const want = normalizeNumber(fromNumber);
  if (!want) {
    return Promise.reject(new Error("waitForInboundFrom: fromNumber is empty"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inboundWaiters.delete(entry);
      reject(
        new Error(
          `Timeout after ${timeoutMs}ms waiting for inbound SMS from ${want} (check inbound webhook URL and ngrok).`
        )
      );
    }, timeoutMs);

    function entry(payload, fullText) {
      const from = senderKeyFromInboundPayload(payload);
      if (from !== want) return;
      clearTimeout(timer);
      inboundWaiters.delete(entry);
      resolve({ text: fullText, from, raw: payload });
    }

    inboundWaiters.add(entry);
  });
}

function notifyInboundWaiters(payload, fullText) {
  for (const fn of [...inboundWaiters]) {
    try {
      fn(payload, fullText);
    } catch (e) {
      console.error("inbound waiter error:", e);
    }
  }
}

/** Wait for a delivery receipt on /sms/status whose message id matches (Vonage uses message-id / messageId). */
export function waitForDlrById(messageId, timeoutMs = 45000) {
  const id = String(messageId ?? "").trim();
  if (!id) {
    return Promise.reject(new Error("waitForDlrById: messageId is empty"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dlrWaiters.delete(entry);
      reject(new Error(`Timeout after ${timeoutMs}ms waiting for DLR for message id ${id}`));
    }, timeoutMs);

    function entry(payload) {
      const mid = String(
        payload["message-id"] ?? payload.messageId ?? payload.message_id ?? ""
      ).trim();
      if (mid !== id) return;
      clearTimeout(timer);
      dlrWaiters.delete(entry);
      resolve(payload);
    }

    dlrWaiters.add(entry);
  });
}

function notifyDlrWaiters(payload) {
  for (const fn of [...dlrWaiters]) {
    try {
      fn(payload);
    } catch (e) {
      console.error("dlr waiter error:", e);
    }
  }
}

/* ================= ENV VALIDATION ================= */
function envTrim(s) {
  return (s == null ? "" : String(s)).trim();
}

function envBool(v, defaultVal = false) {
  if (v == null || String(v).trim() === "") return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultVal;
}

const VONAGE_API_KEY = envTrim(process.env.VONAGE_API_KEY);
const VONAGE_API_SECRET = envTrim(process.env.VONAGE_API_SECRET);
const VONAGE_FROM =
  envTrim(process.env.VONAGE_FROM) || envTrim(process.env.VONAGE_VIRTUAL_NUMBER);

if (!VONAGE_API_KEY || !VONAGE_API_SECRET || !VONAGE_FROM) {
  console.error(
    "❌ Missing Vonage SMS vars: set VONAGE_API_KEY, VONAGE_API_SECRET, and VONAGE_FROM (or VONAGE_VIRTUAL_NUMBER as sender)"
  );
  process.exit(1);
}

/* Dealer / other party only — do not fall back to VONAGE_VIRTUAL_NUMBER (that is your customer/sender line). */
const DEALER_RAW = envTrim(process.env.DEALER_TO) || envTrim(process.env.BOT_TO);
const PEER_KEY = normalizeNumber(DEALER_RAW);

if (!PEER_KEY) {
  console.error(
    "❌ Missing dealer number: set DEALER_TO or BOT_TO to the dealer’s phone (digits / E.164)"
  );
  process.exit(1);
}

const MOCK_SMS =
  String(process.env.MOCK_SMS || "").toLowerCase() === "true" ||
  process.env.MOCK_SMS === "1";

/** Legacy: when true, never restrict by dealer phone (same as default today). */
const INBOUND_SMS_ACCEPT_ANY = envBool(process.env.INBOUND_SMS_ACCEPT_ANY, false);

/**
 * When true, only inbound whose sender matches DEALER_TO/BOT_TO is shown.
 * Default false so real dealer replies still appear if Vonage msisdn formatting differs from .env.
 */
const INBOUND_ONLY_DEALER = envBool(process.env.INBOUND_ONLY_DEALER, false);

/** When true, browser calls POST /api/chat/clear on every load (wipes in-memory inbound). Default false so replies are not lost on refresh. */
const CLEAR_THREAD_ON_LOAD = envBool(process.env.CLEAR_THREAD_ON_LOAD, false);

/** UI thread poll interval (ms); 0 disables. Catches inbound if WebSocket misses. */
const THREAD_POLL_MS = (() => {
  const raw = envTrim(process.env.THREAD_POLL_MS);
  if (raw === "") return 5000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5000;
  return Math.max(0, Math.min(120_000, n));
})();

const DEALER_LABEL = envTrim(process.env.DEALER_LABEL) || "Dealer";

const OUR_LVN_KEY = normalizeNumber(VONAGE_FROM);

/** Strict dealer-only filter (Postman noise) — off unless INBOUND_ONLY_DEALER=1 and not ACCEPT_ANY */
const inboundRestrictDealerSender = INBOUND_ONLY_DEALER && !INBOUND_SMS_ACCEPT_ANY;

if (inboundRestrictDealerSender) {
  console.log(
    "[inbound-sms] Dealer-only mode: only MO from %s (%s). Unset INBOUND_ONLY_DEALER to accept any sender texting your Vonage number.",
    DEALER_LABEL,
    formatPhoneDisplay(PEER_KEY)
  );
} else {
  console.log(
    "[inbound-sms] Accepting MO from any sender to your LVN. Set INBOUND_ONLY_DEALER=1 to limit to DEALER_TO only."
  );
}

/* ================= THREAD STORE ================= */
const threads = new Map();

function getThread(key) {
  if (!threads.has(key)) threads.set(key, []);
  return threads.get(key);
}

function addMessage(key, msg) {
  const t = getThread(key);
  t.push(msg);
  t.sort((a, b) => {
    if ((a.ts || 0) !== (b.ts || 0)) return (a.ts || 0) - (b.ts || 0);
    return (a.seq || 0) - (b.seq || 0);
  });
  if (t.length > 500) t.splice(0, t.length - 500);
}

/** Vonage message-id -> thread + client bubble id (for DLR updates). */
const outgoingByVonageId = new Map();

const DLR_FAILED = new Set([
  "failed",
  "rejected",
  "expired",
  "undeliverable",
  "unknown"
]);

function isFailedDlrStatus(status) {
  return DLR_FAILED.has(String(status || "").toLowerCase());
}

/* ================= CONCAT BUFFER ================= */
const concatBuffer = new Map();
const CONCAT_TIMEOUT = 60000;

function handleConcatenatedSms(payload) {
  const ref = payload["concat-ref"];
  const part = parseInt(String(payload["concat-part"] || "1"), 10) || 1;
  const total = parseInt(String(payload["concat-total"] || "1"), 10) || 1;
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

/* ================= API: CONFIG ================= */
app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    with: PEER_KEY,
    dealerLabel: DEALER_LABEL,
    dealerDisplay: formatPhoneDisplay(PEER_KEY),
    vonageFrom: OUR_LVN_KEY,
    vonageDisplay: formatPhoneDisplay(OUR_LVN_KEY),
    mockSms: MOCK_SMS,
    clearThreadOnLoad: CLEAR_THREAD_ON_LOAD,
    threadPollMs: THREAD_POLL_MS
  });
});

/* ================= API: THREAD ================= */
app.get("/api/chat/thread", (req, res) => {
  const key = normalizeNumber(req.query.with || "") || PEER_KEY;

  res.json({
    ok: true,
    with: key,
    messages: getThread(key)
  });
});

/* ================= API: SEND ================= */
app.post("/api/chat/send", async (req, res) => {
  const key = normalizeNumber(req.body.to || "") || PEER_KEY;
  const text = (req.body.text || "").trim();

  if (!text) return res.status(400).json({ ok: false });

  if (MOCK_SMS) {
    const meta = nextMessageMeta("out");
    const msg = {
      id: meta.id,
      dir: "out",
      text,
      ts: meta.ts,
      seq: meta.seq
    };
    addMessage(key, msg);
    req.app.get("notifyWs")?.(key, msg);
    return res.json({ ok: true, mock: true });
  }

  let data;
  try {
    data = await sendSms({ to: key, text });
  } catch (e) {
    const body = e?.response?.data;
    const detail =
      typeof body === "object" && body != null
        ? JSON.stringify(body)
        : e?.message || String(e);
    console.error("[api/chat/send] Vonage request failed:", detail);
    return res.status(502).json({
      ok: false,
      error: "Vonage SMS request failed",
      detail
    });
  }

  const first = data?.messages?.[0];
  const st = first?.status;
  const vonageId = String(first?.["message-id"] || first?.messageId || first?.message_id || "").trim();
  const clientId = String(req.body.clientId || "").trim();

  if (st !== "0" && st !== 0) {
    const errorText = first?.["error-text"] || first?.error_text || "Vonage rejected the message";
    console.error("[api/chat/send] Vonage rejected to=%s status=%s %s", key, st, errorText);
    return res.status(502).json({
      ok: false,
      vonageStatus: String(st),
      errorText
    });
  }

  console.log("[api/chat/send] accepted by Vonage to=%s message-id=%s", key, vonageId || "(none)");

  const meta = nextMessageMeta("out");
  const msg = {
    id: meta.id,
    dir: "out",
    text,
    ts: meta.ts,
    seq: meta.seq,
    vonageId: vonageId || undefined,
    clientId: clientId || undefined
  };

  addMessage(key, msg);

  if (vonageId) {
    outgoingByVonageId.set(vonageId, { key, clientId: clientId || meta.id, serverId: meta.id });
  }

  req.app.get("notifyWs")?.(key, msg);

  res.json({ ok: true, vonageId, id: meta.id });
});

/* ================= VONAGE INBOUND ================= */
app.all("/api/vonage/inbound-sms", (req, res) => {
  const qKeys =
    typeof req.query === "object" && req.query ? Object.keys(req.query).join(",") : "";
  console.log(
    "[inbound-sms] HTTP hit method=%s ct=%s query_keys=%s",
    req.method,
    req.headers["content-type"] || "",
    qKeys || "(none)"
  );

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const raw = {
    ...(typeof req.query === "object" && req.query ? req.query : {}),
    ...(typeof body === "object" && body && !Buffer.isBuffer(body) ? body : {})
  };
  const payload = normalizeInboundSmsPayload(raw);

  const fullText = handleConcatenatedSms(payload);
  if (!fullText) {
    const concatTotal = parseInt(String(payload["concat-total"] ?? "1"), 10);
    const waitingConcat =
      payload["concat-ref"] && concatTotal > 1;
    if (!waitingConcat) {
      console.warn(
        "[inbound-sms] skipped (no text / unknown shape). keys=%s type=%s",
        Object.keys(payload).join(","),
        payload.type
      );
    }
    return res.status(200).send("ok");
  }

  console.log(
    "[inbound-sms] from=%s to=%s text_len=%s",
    payload.msisdn,
    payload.to,
    String(fullText).length
  );

  const toRaw = payload.to != null ? String(payload.to) : "";
  const toKey = toRaw ? normalizeNumber(toRaw) : "";
  if (toKey && OUR_LVN_KEY && toKey !== OUR_LVN_KEY) {
    console.warn(
      "[inbound-sms] to=%s does not match VONAGE_FROM %s — check number webhook / account routing",
      toRaw,
      VONAGE_FROM
    );
  }

  const sender = senderKeyFromInboundPayload(payload);
  if (!sender) {
    console.warn("[inbound-sms] ignored (no sender in payload; check Vonage payload shape)");
    return res.status(200).send("ok");
  }
  if (inboundRestrictDealerSender && sender !== PEER_KEY) {
    console.warn(
      "[inbound-sms] ignored sender=%s (dealer-only mode expects %s). Turn off INBOUND_ONLY_DEALER to show all replies.",
      sender,
      PEER_KEY
    );
    return res.status(200).send("ok");
  }

  const meta = nextMessageMeta("in");
  const msg = {
    id: meta.id,
    dir: "in",
    text: fullText,
    ts: meta.ts,
    seq: meta.seq
  };

  notifyInboundWaiters(payload, fullText);

  addMessage(PEER_KEY, msg);

  req.app.get("notifyWs")?.(PEER_KEY, msg);

  res.send("ok");
});

/* ================= DLR ================= */
app.all("/sms/status", (req, res) => {
  const payload = { ...req.query, ...req.body };
  notifyDlrWaiters(payload);

  const vonageId = String(
    payload["message-id"] ?? payload.messageId ?? payload.message_id ?? ""
  ).trim();
  const dlrStatus = String(payload.status ?? payload.Status ?? "").trim();
  console.log(
    "[sms/status] message-id=%s status=%s to=%s",
    vonageId || "(none)",
    dlrStatus || "(none)",
    payload.to || payload.msisdn || ""
  );

  if (vonageId && isFailedDlrStatus(dlrStatus)) {
    const mapped = outgoingByVonageId.get(vonageId);
    const key = mapped?.key || normalizeNumber(payload.to || "") || PEER_KEY;
    const clientId = mapped?.clientId;
    console.error("[sms/status] delivery failed key=%s status=%s — marking Not send", key, dlrStatus);
    req.app.get("notifyWs")?.(key, {
      kind: "delivery",
      dir: "out",
      with: key,
      id: clientId,
      vonageId,
      sent: false,
      dlrStatus
    });
  }

  res.send("ok");
});

/* ================= CLEAR THREAD ================= */
app.post("/api/chat/clear", (req, res) => {
  const key = normalizeNumber(req.body.with || "") || PEER_KEY;
  const serverTime = Date.now();
  threads.set(key, []);
  console.log("🧹 Thread cleared for:", key);
  res.json({ ok: true, serverTime });
});

/* ================= DEV: simulate inbound ================= */
app.post("/api/dev/simulate-inbound", (req, res) => {
  const allowed = MOCK_SMS || process.env.NODE_ENV === "development";
  if (!allowed) return res.status(404).json({ ok: false });

  const text = (req.body.text || "").trim();
  if (!text) return res.status(400).json({ ok: false });

  const meta = nextMessageMeta("in");
  const msg = {
    id: meta.id,
    dir: "in",
    text,
    ts: meta.ts,
    seq: meta.seq
  };

  addMessage(PEER_KEY, msg);
  req.app.get("notifyWs")?.(PEER_KEY, msg);

  res.json({ ok: true });
});

export default app;
