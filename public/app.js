let ws = null;
let currentBot = null;
let vonageNumber = null;
let chatStartTime = 0;
let threadPollMs = 0;
let threadPollTimer = null;
const shownMessages = new Set();
let threads = {}; // Store all threads by bot number

const $ = (id) => document.getElementById(id);

// localStorage keys
const STORAGE_KEYS = {
  THREADS: "sms_bot_threads",
  BOT_NUMBERS: "sms_bot_numbers",
  VONAGE_NUMBER: "sms_vonage_number",
  THREAD_POLL_MS: "sms_thread_poll_ms",
  CURRENT_BOT: "sms_current_bot"
};

// Load threads from localStorage
function loadThreadsFromStorage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.THREADS);
    if (stored) {
      threads = JSON.parse(stored);
    } else {
      threads = {};
    }
  } catch (e) {
    console.error("Error loading threads from localStorage:", e);
    threads = {};
  }
}

// Save threads to localStorage
function saveThreadsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEYS.THREADS, JSON.stringify(threads));
  } catch (e) {
    console.error("Error saving threads to localStorage:", e);
  }
}

// Get thread data for a bot
function getThreadData(botNum) {
  if (!threads[botNum]) {
    threads[botNum] = {
      messages: [],
      createdAt: Date.now(),
      lastMessage: null
    };
  }
  return threads[botNum];
}

// Deduplicate messages by ID (remove duplicates, keeping the first occurrence)
function deduplicateMessages(messages) {
  const seen = new Set();
  const unique = [];
  
  for (const msg of messages) {
    if (!seen.has(msg.id)) {
      seen.add(msg.id);
      unique.push(msg);
    }
  }
  
  return unique;
}

function upsertThreadMessage(botNum, message) {
  if (!botNum || !message) return;
  const thread = getThreadData(botNum);
  if (!message.id) {
    message.id = `msg_${Date.now()}_${Math.random()}`;
  }
  const idx = thread.messages.findIndex((m) => m.id === message.id);
  if (idx === -1) {
    thread.messages.push(message);
  } else {
    thread.messages[idx] = { ...thread.messages[idx], ...message };
  }
  thread.lastMessage = Date.now();
  saveThreadsToStorage();
}

function addThreadMessage(botNum, message) {
  upsertThreadMessage(botNum, message);
}

function isOutgoingDuplicate(botNum, message) {
  if (!botNum || message?.dir !== "out") return false;
  const text = String(message.text || "");
  const ts = Number(message.ts) || 0;
  return getThreadData(botNum).messages.some((x) => {
    if (x.id === message.id) return true;
    if (x.dir !== "out") return false;
    return x.text === text && Math.abs((Number(x.ts) || 0) - ts) < 8000;
  });
}

function renderThreadFromStorage(botNum) {
  if (!botNum) return;
  loadThreadsFromStorage();
  const threadData = getThreadData(botNum);
  if (threadData.messages && threadData.messages.length > 0) {
    threadData.messages = deduplicateMessages(threadData.messages);
    saveThreadsToStorage();
  }

  shownMessages.clear();
  $("chat").innerHTML = "";

  (threadData.messages || []).forEach((m) => {
    if (!m?.id || shownMessages.has(m.id)) return;
    renderMsg(m, true);
    shownMessages.add(m.id);
  });
}

async function mergeApiThread(botNum) {
  if (!botNum) return;
  try {
    const tr = await fetch(`/api/chat/thread?with=${encodeURIComponent(botNum)}`);
    const j = await tr.json();
    for (const m of j.messages || []) {
      if (!m) continue;
      if (m.ts < chatStartTime) continue;
      if (m.id && shownMessages.has(m.id)) continue;
      if (isOutgoingDuplicate(botNum, m)) continue;
      if (m.id) shownMessages.add(m.id);
      renderMsg(m);
    }
  } catch {
    /* offline: keep localStorage thread */
  }
}

// Load all bot numbers from localStorage
function loadBotNumbers() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.BOT_NUMBERS);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    console.error("Error loading bot numbers from localStorage:", e);
    return [];
  }
}

// Save bot numbers to localStorage
function saveBotNumbers(numbers) {
  try {
    localStorage.setItem(STORAGE_KEYS.BOT_NUMBERS, JSON.stringify(numbers));
  } catch (e) {
    console.error("Error saving bot numbers to localStorage:", e);
  }
}

// Load vonage number from localStorage
function loadVonageNumber() {
  try {
    return localStorage.getItem(STORAGE_KEYS.VONAGE_NUMBER) || null;
  } catch (e) {
    console.error("Error loading vonage number from localStorage:", e);
    return null;
  }
}

// Save vonage number to localStorage
function saveVonageNumber(num) {
  try {
    localStorage.setItem(STORAGE_KEYS.VONAGE_NUMBER, num);
  } catch (e) {
    console.error("Error saving vonage number to localStorage:", e);
  }
}

// Load current active bot from localStorage
function loadCurrentBot() {
  try {
    return localStorage.getItem(STORAGE_KEYS.CURRENT_BOT) || null;
  } catch (e) {
    console.error("Error loading current bot from localStorage:", e);
    return null;
  }
}

// Save current active bot to localStorage
function saveCurrentBot(botNum) {
  try {
    if (botNum) {
      localStorage.setItem(STORAGE_KEYS.CURRENT_BOT, botNum);
    } else {
      localStorage.removeItem(STORAGE_KEYS.CURRENT_BOT);
    }
  } catch (e) {
    console.error("Error saving current bot to localStorage:", e);
  }
}

function nationalDigits(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return d;
}

function avatarDigits(phone) {
  return nationalDigits(phone).slice(0, 2) || "?";
}

function formatBotNumberInput(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 10);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getSearchDigits() {
  return formatBotNumberInput($("searchBotNumber")?.value || "");
}

function numbersMatchingSearch(query) {
  const bots = loadBotNumbers();
  if (!query) return bots;
  return bots.filter((n) => nationalDigits(n).includes(query));
}

function findSavedBotByDigits(digits) {
  if (!digits) return null;
  return loadBotNumbers().find((n) => nationalDigits(n) === digits) || null;
}

// Render all saved bot numbers
function renderBotNumbers() {
  const query = getSearchDigits();
  const botNumbers = numbersMatchingSearch(query);
  const container = $("botNumbersList");
  container.innerHTML = "";

  if (botNumbers.length === 0) {
    const emptyText = query
      ? "No matching number. Click Add to start a new thread."
      : "Add a bot number to get started";
    container.innerHTML = `<div style="color: #94a3b8; font-size: 12px; padding: 12px; text-align: center;">${emptyText}</div>`;
    return;
  }

  botNumbers.forEach((botNum) => {
    const item = document.createElement("div");
    item.className = "botNumberItem";
    if (botNum === currentBot) {
      item.classList.add("active");
    }

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "botAvatar";
    avatar.textContent = avatarDigits(botNum);
    item.appendChild(avatar);

    // Info container
    const infoDiv = document.createElement("div");
    infoDiv.className = "botNumberInfo";

    // Header with number and live status
    const headerDiv = document.createElement("div");
    headerDiv.className = "botNumberHeader";

    const botNumberSpan = document.createElement("span");
    botNumberSpan.className = "botNumber";
    botNumberSpan.textContent = botNum;
    headerDiv.appendChild(botNumberSpan);

    const liveStatus = document.createElement("span");
    liveStatus.className = "botLiveStatus";
    const indicator = document.createElement("span");
    indicator.className = "botLiveIndicator";
    liveStatus.appendChild(indicator);
    const liveText = document.createElement("span");
    liveText.textContent = "Live";
    liveStatus.appendChild(liveText);
    headerDiv.appendChild(liveStatus);

    infoDiv.appendChild(headerDiv);

    // Preview message
    const threadData = getThreadData(botNum);
    let previewText = "No messages yet";
    if (threadData.messages && threadData.messages.length > 0) {
      const lastMsg = threadData.messages[threadData.messages.length - 1];
      previewText = (lastMsg.dir === "out" ? "You: " : "") + lastMsg.text;
    }

    const previewSpan = document.createElement("div");
    previewSpan.className = "botPreviewMessage";
    previewSpan.textContent = previewText;
    infoDiv.appendChild(previewSpan);

    item.appendChild(infoDiv);

    // Make entire item clickable
    item.addEventListener("click", () => selectBotThread(botNum));
    container.appendChild(item);
  });
}

// Add a new bot number
function addBotNumber() {
  const searchInput = $("searchBotNumber");
  const wrap = searchInput.closest(".phoneInputWrap");
  const digits = formatBotNumberInput(searchInput.value);

  if (digits.length !== 10) {
    wrap?.classList.add("invalid");
    setStatus("Enter a valid 10-digit number");
    return;
  }

  wrap?.classList.remove("invalid");
  const botNum = "+1" + digits;
  const existing = findSavedBotByDigits(digits);

  searchInput.value = "";
  wrap?.classList.remove("invalid");

  if (existing) {
    renderBotNumbers();
    selectBotThread(existing);
    setStatus("Opened existing thread.");
    return;
  }

  const botNumbers = loadBotNumbers();
  botNumbers.push(botNum);
  saveBotNumbers(botNumbers);
  loadThreadsFromStorage();
  getThreadData(botNum);
  saveThreadsToStorage();
  renderBotNumbers();
  selectBotThread(botNum);
  setStatus("New thread added. You can send messages.");
}

// Delete a bot thread
function deleteBotThread(botNum) {
  const botNumbers = loadBotNumbers();
  const index = botNumbers.indexOf(botNum);
  if (index > -1) {
    botNumbers.splice(index, 1);
    saveBotNumbers(botNumbers);

    // Delete from threads
    delete threads[botNum];
    saveThreadsToStorage();

    // If this was the active bot, reset
    if (currentBot === botNum) {
      resetChatState();
      currentBot = null;
      saveCurrentBot(null); // Clear saved current bot
      $("threadTitle").textContent = "Messages";
      $("threadSub").textContent = "Select a bot to start";
      setStatus("Ready to start. Select a bot number or add a new one.");
    }

    renderBotNumbers();
  }
}

// Select a bot thread
function selectBotThread(botNum) {
  if (currentBot === botNum) {
    return; // Already selected
  }

  currentBot = botNum;
  saveCurrentBot(botNum);
  loadThreadsFromStorage();

  $("threadTitle").textContent = botNum;
  $("threadSub").textContent = `Chatting with ${botNum}`;

  renderBotNumbers();
  setStatus("Starting chat...");
  startConversation(false);
}

function setStatus(text) {
  $("status").textContent = text;
  const blockComposer =
    text.startsWith("Disconnected") ||
    text.startsWith("Could not") ||
    text.startsWith("Loading") ||
    text === "Idle." ||
    text === "Configuration not loaded." ||
    text === "Ready to start. Select a bot number or add a new one.";
  setComposerEnabled(!!currentBot && !blockComposer);
}

function setComposerEnabled(enabled) {
  $("msg").disabled = !enabled;
  $("sendBtn").disabled = !enabled;
  $("clearBtn").disabled = !enabled;
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

function renderMsg(m, skipSave = false) {
  const chat = $("chat");
  const meta = messageSortMeta(m);

  // Ensure message has an ID
  if (!m.id) {
    m.id = `msg_${Date.now()}_${Math.random()}`;
  }

  const row = document.createElement("div");
  row.className = "msgRow " + (m.dir === "out" ? "me" : "bot");
  row.dataset.id = m.id;
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
  if (m.sent === false) {
    bubble.classList.add("failed-msg");
  }

  const textSpan = document.createElement("span");
  textSpan.className = "bubble-text";
  textSpan.textContent = m.text;

  const metaSpan = document.createElement("span");
  metaSpan.className = "inline-meta";
  metaSpan.textContent = fmtTime(m.ts);

  if (m.dir === "out" && m.sent === true) {
    const checkSpan = document.createElement("span");
    checkSpan.className = "double-check";
    checkSpan.textContent = " ✓✓";
    metaSpan.appendChild(checkSpan);
  }

  bubble.appendChild(textSpan);
  bubble.appendChild(metaSpan);

  const msgContent = document.createElement("div");
  msgContent.className = "msgContent";
  if (m.sent === false) {
    msgContent.classList.add("failed-message-content");
  }

  msgContent.appendChild(bubble);

  if (m.dir === "out" && m.sent === false) {
    const notSendLabel = document.createElement("div");
    notSendLabel.className = "notSendLabel";
    notSendLabel.textContent = "Not send";
    msgContent.appendChild(notSendLabel);
  }
  
  row.appendChild(msgContent);
  insertRowSorted(chat, row, meta);
  chat.scrollTop = chat.scrollHeight;

  // Save message to localStorage only if it's a new message (not being loaded from storage)
  if (currentBot && !skipSave) {
    upsertThreadMessage(currentBot, m);
    renderBotNumbers();
  }
}

function refreshOutgoingMessage(message) {
  const chat = $("chat");
  const existing = chat.querySelector(`.msgRow[data-id="${CSS.escape(message.id)}"]`);
  if (existing) existing.remove();
  shownMessages.delete(message.id);
  renderMsg(message, true);
  shownMessages.add(message.id);
}

function applyDeliveryFailure(data) {
  const botNum = data.with || currentBot;
  if (!botNum) return;
  const thread = getThreadData(botNum);
  const found = (thread.messages || []).find(
    (m) =>
      (data.id && m.id === data.id) ||
      (data.vonageId && m.vonageId && m.vonageId === data.vonageId)
  );
  if (!found) return;
  found.sent = false;
  upsertThreadMessage(botNum, found);
  if (botNum === currentBot) {
    refreshOutgoingMessage(found);
    setStatus("Not send");
  }
  renderBotNumbers();
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

async function clearCurrentThread() {
  if (!currentBot) {
    setStatus("No thread to clear");
    return;
  }
  resetChatState();

  try {
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

    // Clear from localStorage
    delete threads[currentBot];
    saveThreadsToStorage();
    shownMessages.clear();
    $("chat").innerHTML = "";

    setStatus("Thread cleared. Starting fresh...");
    chatStartTime = typeof clearJson.serverTime === "number" ? clearJson.serverTime : Date.now();
  } catch (err) {
    setStatus("Error clearing thread: " + (err?.message || "Unknown error"));
    return;
  }

  connectWs();
}

async function pullNewInboundFromThread() {
  if (!currentBot) return;
  try {
    const tr = await fetch(`/api/chat/thread?with=${encodeURIComponent(currentBot)}`);
    const j = await tr.json();
    let gotInbound = false;
    for (const m of j.messages || []) {
      if (!m || m.dir === "out") continue;
      if (m.ts < chatStartTime) continue;
      if (m.id && shownMessages.has(m.id)) continue;
      if (m.id) shownMessages.add(m.id);
      renderMsg(m);
      gotInbound = true;
    }
    if (gotInbound) setStatus("Reply received");
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
    chatStartTime = 0;
  }

  renderThreadFromStorage(currentBot);
  renderBotNumbers();
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

    await mergeApiThread(currentBot);
    startThreadPoll();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const message = msg.data;

    if (!message) return;

    if (message.kind === "delivery" || (message.dir === "out" && message.sent === false)) {
      applyDeliveryFailure(message);
      return;
    }

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

  const msgObj = {
    id: `msg_${Date.now()}_${Math.random()}`,
    dir: "out",
    text,
    ts: Date.now(),
    sent: null
  };

  upsertThreadMessage(currentBot, msgObj);
  renderMsg(msgObj, true);
  renderBotNumbers();
  setStatus("Sending…");

  let retries = 3;
  let delay = 1000;
  let lastError = "Send failed";

  while (retries > 0) {
    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, to: currentBot, clientId: msgObj.id })
      });

      let payload = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }

      if (res.ok && payload.ok !== false) {
        msgObj.sent = true;
        if (payload.vonageId) msgObj.vonageId = payload.vonageId;
        upsertThreadMessage(currentBot, msgObj);
        refreshOutgoingMessage(msgObj);
        renderBotNumbers();
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
      lastError = err?.message || "Send failed";
      if (retries > 0) {
        setStatus(`Sending… (retry ${4 - retries}/3): ${lastError}`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      } else {
        msgObj.sent = false;
        upsertThreadMessage(currentBot, msgObj);
        refreshOutgoingMessage(msgObj);
        renderBotNumbers();
        setStatus("Not send");
      }
    }
  }
}

function restoreSavedThread() {
  renderBotNumbers();
  const savedBotNum = loadCurrentBot();
  if (savedBotNum) {
    const botNumbers = loadBotNumbers();
    if (botNumbers.includes(savedBotNum)) {
      selectBotThread(savedBotNum);
      return true;
    }
    saveCurrentBot(null);
  }
  setStatus("Ready to start. Select a bot number or add a new one.");
  return false;
}

async function bootstrap() {
  loadThreadsFromStorage();

  setStatus("Loading configuration...");
  setComposerEnabled(false);

  let res;
  try {
    res = await fetch("/api/config");
  } catch {
    setStatus("Could not reach server. Showing saved threads.");
    restoreSavedThread();
    return;
  }

  const cfg = await res.json();
  if (!cfg.ok) {
    setStatus("Could not load config. Showing saved threads.");
    restoreSavedThread();
    return;
  }

  // Store vonage number
  const vonageDisplay = cfg.vonageDisplay || cfg.vonageFrom || "";
  if (vonageDisplay) {
    vonageNumber = vonageDisplay;
    saveVonageNumber(vonageNumber);
  } else {
    vonageNumber = loadVonageNumber();
  }

  threadPollMs = Number(cfg.threadPollMs) || 0;
  if (threadPollMs < 0) threadPollMs = 0;

  restoreSavedThread();
}

$("addBotBtn").addEventListener("click", addBotNumber);

function onBotNumberSearch() {
  const input = $("searchBotNumber");
  input.value = formatBotNumberInput(input.value);
  input.closest(".phoneInputWrap")?.classList.toggle(
    "invalid",
    input.value.length > 0 && input.value.length !== 10
  );
  renderBotNumbers();
}

$("searchBotNumber").addEventListener("input", onBotNumberSearch);
$("searchBotNumber").addEventListener("keyup", onBotNumberSearch);

$("searchBotNumber").addEventListener("paste", (e) => {
  e.preventDefault();
  const pasted = (e.clipboardData || window.clipboardData).getData("text");
  e.target.value = formatBotNumberInput(pasted);
  e.target.dispatchEvent(new Event("input"));
});

$("searchBotNumber").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    addBotNumber();
    return;
  }
  if (!/[0-9]/.test(e.key)) {
    e.preventDefault();
  }
});

$("clearBtn").addEventListener("click", clearCurrentThread);

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
