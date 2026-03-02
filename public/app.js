let ws = null;
let currentBot = null;

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

/* ================= UI HELPERS ================= */

function setStatus(text) {
  $("status").textContent = text;
}

function setLive(on) {
  $("dot").className = "dot " + (on ? "live" : "idle");
  $("liveTxt").textContent = on ? "Live" : "Offline";
}

/* ================= RENDER MESSAGE ================= */

function renderMsg(m) {
  const chat = $("chat");

  const row = document.createElement("div");
  row.className = "msgRow " + (m.dir === "out" ? "me" : "bot");

  if (m.dir !== "out") {
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = "A";
    row.appendChild(av);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = m.text;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = fmtTime(m.ts);

  const wrap = document.createElement("div");
  wrap.appendChild(bubble);
  wrap.appendChild(meta);

  row.appendChild(wrap);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

/* ================= RESET STATE ================= */

function resetChatState() {
  // 🔥 Close old WebSocket
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = null;
    ws.close();
    ws = null;
  }

  currentBot = null;

  // 🔥 Clear chat UI
  $("chat").innerHTML = "";

  // Reset UI indicators
  setLive(false);
  setStatus("Idle.");
}

/* ================= LOAD THREAD ================= */

async function loadThread() {
  const newBot = $("botTo").value.trim();
  if (!newBot) {
    setStatus("Please enter bot number.");
    return;
  }

  // 🔥 ALWAYS reset before starting new chat
  resetChatState();

  currentBot = newBot;

  // Update header
  $("threadTitle").textContent = currentBot;
  $("threadSub").textContent = "Conversation with bot";

  setLive(true);
  setStatus("Starting new chat…");

  // ⚠️ Do NOT load previous messages
  // If you ever want history back, re-add fetch here

  connectWs();
  setStatus("Connected. You can send messages.");
}

/* ================= WEBSOCKET ================= */

function connectWs() {
  if (!currentBot || ws) return;

  ws = new WebSocket("wss://" + location.host);

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        with: currentBot
      })
    );
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    // 🔥 Ignore echoed outgoing messages
    if (msg.data?.dir === "out") return;

    renderMsg(msg.data);
    setStatus("Bot replied");
  };

  ws.onclose = () => {
    setLive(false);
    setStatus("Disconnected. Reload chat to reconnect.");
    ws = null;
  };
}

/* ================= SEND MESSAGE ================= */

async function sendMsg() {
  if (!currentBot) {
    setStatus("Load a chat first.");
    return;
  }

  const text = $("msg").value.trim();
  if (!text) return;

  $("msg").value = "";

  // 🔥 Optimistic UI
  renderMsg({
    dir: "out",
    text,
    ts: Date.now()
  });

  setStatus("Sending…");

  await fetch("/api/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: currentBot, text })
  });

  setStatus("Waiting for bot reply…");
}

/* ================= EVENTS ================= */

$("loadBtn").addEventListener("click", loadThread);
$("sendBtn").addEventListener("click", sendMsg);
