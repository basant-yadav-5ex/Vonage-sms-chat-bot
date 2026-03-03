let ws = null;
let currentBot = null;

const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

/* ================= UI HELPERS ================= */

function setStatus(text) {
  document.getElementById("status").textContent = text;

  if (text === "Idle.") {
    setComposerEnabled(false);
  } else {
    setComposerEnabled(true);
  }
}

function setComposerEnabled(enabled) {
  document.getElementById("msg").disabled = !enabled;
  document.getElementById("sendBtn").disabled = !enabled;
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

  const msgContent = document.createElement("div");
  msgContent.className = "msgContent";

  if (m.dir !== "out") {
    const name = document.createElement("div");
    name.className = "msgName";
    // name.textContent = "AIVA";
    msgContent.appendChild(name);
  }

  msgContent.appendChild(bubble);
  msgContent.appendChild(meta);

  row.appendChild(msgContent);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

/* ================= TYPING INDICATOR ================= */

function showTyping() {
  const chat = $("chat");

  const row = document.createElement("div");
  row.className = "msgRow bot";
  row.id = "typingIndicator";

  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = "A";
  row.appendChild(av);

  const msgContent = document.createElement("div");
  msgContent.className = "msgContent";

  const name = document.createElement("div");
  name.className = "msgName";
  // name.textContent = "AIVA";
  msgContent.appendChild(name);

  const typing = document.createElement("div");
  typing.className = "typing";
  typing.innerHTML = '<div class="dot-typing"></div><div class="dot-typing"></div><div class="dot-typing"></div>';
  msgContent.appendChild(typing);

  row.appendChild(msgContent);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

function removeTyping() {
  const indicator = $("typingIndicator");
  if (indicator) indicator.remove();
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

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(protocol + "//" + location.host);

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

    removeTyping();
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
  showTyping();

  // 🔥 Retry logic with exponential backoff
  let retries = 3;
  let delay = 1000;

  while (retries > 0) {
    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: currentBot, text })
      });

      if (res.ok) {
        setStatus("Waiting for bot reply…");
        return;
      }

      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      retries--;
      if (retries > 0) {
        setStatus(`Sending… (retry ${4 - retries}/3)`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        removeTyping();
        setStatus("Failed to send message. Please try again.");
      }
    }
  }
}

/* ================= EVENTS ================= */

$("loadBtn").addEventListener("click", loadThread);
$("sendBtn").addEventListener("click", sendMsg);
