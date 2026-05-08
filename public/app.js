let ws = null;
let currentBot = null;
let currentCustomer = null;
let chatStartTime = 0;
const shownMessages = new Set();
let userMessageSent = false;


const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function normalizeNumber(input) {
  return (input || "").replace(/\D/g, "");
}

function isPhoneLengthValid(number) {
  return number.length === 10 || number.length === 11;
}

function validateStartChat() {
  const customerNumber = normalizeNumber($("customerNumber").value);
  const botNumber = normalizeNumber($("botNumber").value);

  const hasValidCustomer = isPhoneLengthValid(customerNumber);
  const hasValidBot = isPhoneLengthValid(botNumber);
  const hasMatchingLength =
    hasValidCustomer && hasValidBot && customerNumber.length === botNumber.length;

  $("loadBtn").disabled = !hasMatchingLength;

  if (!customerNumber) {
    setStatus("Enter a customer number to start chat.");
    setComposerEnabled(false);
    return;
  }

  if (!hasValidCustomer) {
    setStatus("Customer number must be 10 or 11 digits.");
    setComposerEnabled(false);
    return;
  }

  if (!hasValidBot) {
    setStatus("Bot number must be 10 or 11 digits.");
    setComposerEnabled(false);
    return;
  }

  if (!hasMatchingLength) {
    setStatus("Customer and bot numbers must have the same length.");
    setComposerEnabled(false);
    return;
  }

  if (!currentCustomer) {
    setStatus("Ready to start chat.");
    setComposerEnabled(false);
  }
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

  // Create a container for text and time
  const textSpan = document.createElement("span");
  textSpan.textContent = m.text;

  const metaSpan = document.createElement("span");
  metaSpan.className = "inline-meta";
  metaSpan.textContent = fmtTime(m.ts);

  // Add double check mark for sent messages (optional)
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

  if (m.dir !== "out") {
    const name = document.createElement("div");
    name.className = "msgName";
    msgContent.appendChild(name);
  }

  msgContent.appendChild(bubble);
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
  currentCustomer = null;

  // clear shown messages
  shownMessages.clear();

  // 🔥 Clear chat UI
  $("chat").innerHTML = "";

  // Reset UI indicators
  setLive(false);
  setStatus("Idle.");
}

/* ================= LOAD THREAD ================= */

async function loadThread() {
  const newCustomer = normalizeNumber($("customerNumber").value);
  const newBot = normalizeNumber($("botNumber").value);

  if (!isPhoneLengthValid(newCustomer)) {
    setStatus("Customer number must be 10 or 11 digits.");
    return;
  }

  if (!isPhoneLengthValid(newBot)) {
    setStatus("Bot number must be 10 or 11 digits.");
    return;
  }

  if (newCustomer.length !== newBot.length) {
    setStatus("Customer and bot numbers must have the same length.");
    return;
  }

  resetChatState();

  currentCustomer = newCustomer;
  currentBot = newBot;

  // mark chat start time
  chatStartTime = Date.now();
  userMessageSent = false;
  // 🔥 clear server chat memory
  await fetch("/api/chat/clear", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ with: currentCustomer })
  });

  $("threadTitle").textContent = currentCustomer;
  $("threadSub").textContent = `Bot ${currentBot}`;

  setLive(true);
  setStatus("Starting new chat…");

  connectWs();

  setStatus("Connected. You can send messages.");
}

/* ================= WEBSOCKET ================= */

function connectWs() {
  if (!currentCustomer || ws) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(protocol + "//" + location.host);

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        with: currentCustomer
      })
    );
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const message = msg.data;

    if (!message) return;

    if (message.dir === "out") return;

    if (message.ts < chatStartTime) return;

    if (shownMessages.has(message.id)) return;
    shownMessages.add(message.id);

    if (!userMessageSent) return;

    removeTyping();
    renderMsg(message);
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
  if (!currentCustomer || !currentBot) {
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

  userMessageSent = true;

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
        body: JSON.stringify({ to: currentCustomer, from: currentBot, text })
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
$("customerNumber").addEventListener("input", validateStartChat);
$("botNumber").addEventListener("input", validateStartChat);

validateStartChat();
