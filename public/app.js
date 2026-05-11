let ws = null;
let currentBot = null;
let vonageNumber = null;
let chatStartTime = 0;
let threadPollMs = 0;
let threadPollTimer = null;
const shownMessages = new Set();

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setStatus(text) {
  $("status").textContent = text;
  const blockComposer =
    text.startsWith("Disconnected") ||
    text.startsWith("Could not") ||
    text.startsWith("Loading") ||
    text === "Idle." ||
    text === "Configuration not loaded.";
  setComposerEnabled(!!currentBot && !blockComposer);
}

function setComposerEnabled(enabled) {
  $("msg").disabled = !enabled;
  $("sendBtn").disabled = !enabled;
}

function setLive(on) {
  $("dot").className = "dot " + (on ? "live" : "idle");
  $("liveTxt").textContent = on ? "Live" : "Offline";
}

function messageSortMeta(m) {
  const ts = Number(m?.ts) || 0;
  const seq = Number(m?.seq) || 0;
  return { ts, seq };
}

function comesBefore(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts;
  return a.seq < b.seq;
}

function insertRowSorted(chat, row, meta) {
  const rows = chat.querySelectorAll(".msgRow");
  for (const existing of rows) {
    const cur = {
      ts: Number(existing.dataset.ts) || 0,
      seq: Number(existing.dataset.seq) || 0
    };
    if (comesBefore(meta, cur)) {
      chat.insertBefore(row, existing);
      return;
    }
  }
  chat.appendChild(row);
}

function renderMsg(m) {
  const chat = $("chat");
  const meta = messageSortMeta(m);

  const row = document.createElement("div");
  row.className = "msgRow " + (m.dir === "out" ? "me" : "bot");
  row.dataset.ts = String(meta.ts);
  row.dataset.seq = String(meta.seq);

  if (m.dir !== "out") {
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = "B";
    row.appendChild(av);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const textSpan = document.createElement("span");
  textSpan.textContent = m.text;

  const metaSpan = document.createElement("span");
  metaSpan.className = "inline-meta";
  metaSpan.textContent = fmtTime(m.ts);

  if (m.dir === "out") {
    const checkSpan = document.createElement("span");
    checkSpan.className = "double-check";
    checkSpan.textContent = " ✓✓";
    metaSpan.appendChild(checkSpan);
  }

  bubble.appendChild(textSpan);
  bubble.appendChild(metaSpan);

  const msgContent = document.createElement("div");
  msgContent.className = "msgContent";

  msgContent.appendChild(bubble);
  row.appendChild(msgContent);
  insertRowSorted(chat, row, meta);
  chat.scrollTop = chat.scrollHeight;
}

function stopThreadPoll() {
  if (threadPollTimer) {
    clearInterval(threadPollTimer);
    threadPollTimer = null;
  }
}

function resetChatState() {
  stopThreadPoll();
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = null;
    ws.close();
    ws = null;
  }

  shownMessages.clear();
  $("chat").innerHTML = "";
  setLive(false);
}

async function pullNewInboundFromThread() {
  if (!currentBot) return;
  try {
    const tr = await fetch(`/api/chat/thread?with=${encodeURIComponent(currentBot)}`);
    const j = await tr.json();
    for (const m of j.messages || []) {
      if (m.dir === "out") continue;
      if (m.ts < chatStartTime) continue;
      if (shownMessages.has(m.id)) continue;
      shownMessages.add(m.id);
      renderMsg(m);
      setStatus("Reply received");
    }
  } catch {
    /* ignore */
  }
}

function startThreadPoll() {
  stopThreadPoll();
  if (!threadPollMs) return;
  threadPollTimer = setInterval(pullNewInboundFromThread, threadPollMs);
}

async function startConversation(clearThreadOnLoad) {
  if (!currentBot) return;

  resetChatState();

  if (clearThreadOnLoad) {
    const clearRes = await fetch("/api/chat/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ with: currentBot })
    });
    let clearJson = {};
    try {
      clearJson = await clearRes.json();
    } catch {
      clearJson = {};
    }
    /* Same clock as message `ts` from server — avoids dropping inbound when browser time ≠ server time */
    chatStartTime =
      typeof clearJson.serverTime === "number" ? clearJson.serverTime : Date.now();
  } else {
    /* Keep server thread; show all stored inbound after load (fixes “SMS arrived then refresh erased it”). */
    chatStartTime = 0;
  }

  setStatus("Loading…");

  connectWs();
}

function connectWs() {
  if (!currentBot || ws) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(protocol + "//" + location.host);

  ws.onopen = async () => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        with: String(currentBot)
      })
    );
    setLive(true);
    setStatus("Connected. You can send messages.");

    await pullNewInboundFromThread();
    startThreadPoll();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const message = msg.data;

    if (!message) return;

    if (message.dir === "out") return;

    if (message.ts < chatStartTime) return;

    if (shownMessages.has(message.id)) return;
    shownMessages.add(message.id);

    renderMsg(message);
    setStatus("Reply received");
  };

  ws.onclose = () => {
    stopThreadPoll();
    setLive(false);
    setStatus("Disconnected. Reload the page to reconnect.");
    ws = null;
  };
}

async function sendMsg() {
  if (!currentBot) {
    setStatus("Configuration not loaded.");
    return;
  }

  const text = $("msg").value.trim();
  if (!text) return;

  $("msg").value = "";

  renderMsg({
    dir: "out",
    text,
    ts: Date.now()
  });

  setStatus("Sending…");

  let retries = 3;
  let delay = 1000;

  while (retries > 0) {
    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, to: currentBot })
      });

      let payload = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }

      if (res.ok && payload.ok !== false) {
        setStatus("Waiting for reply…");
        return;
      }

      const errLine =
        payload.errorText ||
        payload.error ||
        (typeof payload.detail === "string" ? payload.detail : "") ||
        `HTTP ${res.status}`;
      throw new Error(String(errLine).slice(0, 300));
    } catch (err) {
      retries--;
      const reason = err?.message || "Send failed";
      if (retries > 0) {
        setStatus(`Sending… (retry ${4 - retries}/3): ${reason}`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      } else {
        setStatus(`Failed to send: ${reason}`);
      }
    }
  }
}

async function bootstrap() {
  setStatus("Ready to start. Verify numbers and click Start.");
  setComposerEnabled(false);

  let res;
  try {
    res = await fetch("/api/config");
  } catch {
    setStatus("Could not reach server.");
    return;
  }

  const cfg = await res.json();
  if (!cfg.ok || !cfg.with) {
    setStatus("Could not load config.");
    return;
  }

  const display = cfg.dealerDisplay || cfg.with;
  const vonageDisplay = cfg.vonageDisplay || cfg.vonageFrom || "";

  $("botNumber").value = display;
  $("customerNumber").value = vonageDisplay;

  threadPollMs = Number(cfg.threadPollMs) || 0;
  if (threadPollMs < 0) threadPollMs = 0;
}

async function startChat() {
  const botNum = $("botNumber").value.trim();
  const fromVonageNum = $("customerNumber").value.trim();

  if (!botNum) {
    setStatus("Please enter Bot Number");
    return;
  }

  if (!fromVonageNum) {
    setStatus("Please enter Vonage Number");
    return;
  }

  currentBot = botNum; // Listen for replies from bot
  vonageNumber = fromVonageNum; // Display sender number from config
  $("threadTitle").textContent = "Bot Number";
  $("threadSub").textContent = `${botNum} (bot) • From ${vonageNumber}`;

  setStatus("Starting chat...");
  await startConversation(true);
}

$("startBtn").addEventListener("click", startChat);

$("sendBtn").addEventListener("click", sendMsg);

$("msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMsg();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  bootstrap();
});
