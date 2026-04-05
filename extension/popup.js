const generator = globalThis.PlaywrightRecorderGenerator;

let currentRecording = {
  startedAt: null,
  stoppedAt: null,
  events: []
};
let isRecording = false;
let recordingTabId = null;
let liveSyncTimer = null;
let stateSyncTimer = null;
let statusLockedUntil = 0;
const STATUS_LOCK_DURATION_MS = 8000;
const DEFAULT_SETTINGS = {
  defaultUseDelay: true,
  liveSyncIntervalMs: 500
};
let popupSettings = {
  ...DEFAULT_SETTINGS
};
let aiProcessing = false;
let btwQueue = [];

const elements = {
  recordOnBtn: document.getElementById("recordOnBtn"),
  recordOffBtn: document.getElementById("recordOffBtn"),
  useDelayCheckbox: document.getElementById("useDelayCheckbox"),
  skipOnErrorCheckbox: document.getElementById("skipOnErrorCheckbox"),
  downloadCodeBtn: document.getElementById("downloadCodeBtn"),
  formatCodeBtn: document.getElementById("formatCodeBtn"),
  copyCodeBtn: document.getElementById("copyCodeBtn"),
  replayBtn: document.getElementById("replayBtn"),
  status: document.getElementById("status"),
  codeOutput: document.getElementById("codeOutput"),
  chatMessages: document.getElementById("chatMessages"),
  aiPromptInput: document.getElementById("aiPromptInput"),
  aiPromptBtn: document.getElementById("aiPromptBtn")
};

function formatLocalTime(isoString) {
  if (!isoString) {
    return "";
  }

  try {
    return new Date(isoString).toLocaleTimeString();
  } catch (_error) {
    return isoString;
  }
}

function setStatus(message, lock) {
  if (lock) {
    statusLockedUntil = Date.now() + STATUS_LOCK_DURATION_MS;
  } else if (Date.now() < statusLockedUntil) {
    return;
  }
  elements.status.textContent = message;
}

function safeHandler(fn) {
  return async function handler() {
    try {
      await fn.apply(this, arguments);
    } catch (error) {
      setStatus("Error: " + error.message, true);
    }
  };
}

function renderRecordingToggle() {
  elements.recordOnBtn.classList.toggle("is-active", isRecording);
  elements.recordOnBtn.classList.toggle("is-idle", !isRecording);
  elements.recordOffBtn.classList.toggle("is-active", !isRecording);
  elements.recordOffBtn.classList.toggle("is-idle", isRecording);
}

async function loadPopupSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  popupSettings = {
    ...DEFAULT_SETTINGS,
    ...stored
  };
  elements.useDelayCheckbox.checked = popupSettings.defaultUseDelay;
}

function downloadText(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wrapToken(className, value) {
  return '<span class="' + className + '">' + escapeHtml(value) + "</span>";
}

function highlightTypeScript(text) {
  const tokenRegex =
    /\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|return|await|async|if|else|try|catch|require|new|true|false|null|undefined|import|from|export)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\()/g;

  let result = "";
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    const token = match[0];
    result += escapeHtml(text.slice(lastIndex, match.index));

    if (token.startsWith("//")) {
      result += wrapToken("tok-comment", token);
    } else if (/^["'`]/.test(token)) {
      result += wrapToken("tok-string", token);
    } else if (/^\d/.test(token)) {
      result += wrapToken("tok-number", token);
    } else if (/^(const|let|var|return|await|async|if|else|try|catch|require|new|true|false|null|undefined|import|from|export)$/.test(token)) {
      result += wrapToken("tok-keyword", token);
    } else {
      result += wrapToken("tok-fn", token);
    }

    lastIndex = tokenRegex.lastIndex;
  }

  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function renderCodeLines(codeText) {
  const lines = codeText.split("\n");
  const fragment = document.createDocumentFragment();
  lines.forEach(function (line) {
    const div = document.createElement("div");
    div.className = "code-line";
    const span = document.createElement("span");
    span.className = "line-content";
    span.innerHTML = highlightTypeScript(line); // escapeHtml applied inside highlightTypeScript
    div.appendChild(span);
    fragment.appendChild(div);
  });
  elements.codeOutput.textContent = "";
  elements.codeOutput.appendChild(fragment);
}

function renderOutputs() {
  const codeText = generator.generatePlaywrightCode(currentRecording, {
    useDelays: elements.useDelayCheckbox.checked
  });
  renderCodeLines(codeText);
}

function startLiveSync() {
  stopLiveSync();
  liveSyncTimer = setInterval(() => {
    syncRecordingSnapshot().catch(() => {});
  }, Math.max(100, Number(popupSettings.liveSyncIntervalMs) || DEFAULT_SETTINGS.liveSyncIntervalMs));
}

function stopLiveSync() {
  if (liveSyncTimer) {
    clearInterval(liveSyncTimer);
    liveSyncTimer = null;
  }
}

function startStateSync() {
  stopStateSync();
  stateSyncTimer = setInterval(() => {
    refreshRecorderState(false).catch(() => {});
  }, Math.max(200, Number(popupSettings.liveSyncIntervalMs) || DEFAULT_SETTINGS.liveSyncIntervalMs));
}

function stopStateSync() {
  if (stateSyncTimer) {
    clearInterval(stateSyncTimer);
    stateSyncTimer = null;
  }
}

async function syncRecordingSnapshot() {
  if (recordingTabId == null) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "GET_RECORDING",
    tabId: recordingTabId
  });

  if (!response || !response.recording) {
    return;
  }

  currentRecording = response.recording;
  renderOutputs();
}

async function refreshRecorderState(loadUiDependencies = true) {
  if (loadUiDependencies) {
    await loadPopupSettings();
  }

  const tab = await getCurrentTab();
  if (recordingTabId == null) {
    recordingTabId = tab.id;
  }

  const state = await chrome.runtime.sendMessage({
    type: "GET_STATE",
    tabId: recordingTabId
  });

  const recordingChanged = isRecording !== state.recording;
  isRecording = state.recording;
  renderRecordingToggle();
  if (isRecording) {
    await syncRecordingSnapshot();
    startLiveSync();
  } else {
    stopLiveSync();
  }

  if (recordingChanged && !isRecording) {
    await syncRecordingSnapshot();
  }

  setStatus(state.recording ? "Recording in progress" : "Idle");
}

elements.recordOnBtn.addEventListener("click", safeHandler(async () => {
  if (isRecording) {
    setStatus("Recording already on");
    return;
  }

  const tab = await getCurrentTab();
  recordingTabId = tab.id;
  const response = await chrome.runtime.sendMessage({
    type: "START_RECORDING",
    tabId: recordingTabId,
    initialUrl: tab.url
  });

  currentRecording = {
    startedAt: response.session.startedAt,
    stoppedAt: null,
    events: response.session.events || []
  };

  isRecording = true;
  renderRecordingToggle();
  startLiveSync();
  renderOutputs();
  setStatus("Recording started");
}));

elements.recordOffBtn.addEventListener("click", safeHandler(async () => {
  if (!isRecording) {
    setStatus("Recording already off");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "STOP_RECORDING",
    tabId: recordingTabId
  });

  currentRecording = response.recording || currentRecording;
  isRecording = false;
  renderRecordingToggle();
  stopLiveSync();
  renderOutputs();
  setStatus("Recording stopped");
}));

elements.downloadCodeBtn.addEventListener("click", () => {
  downloadText(
    "recording.spec.ts",
    generator.generatePlaywrightCode(currentRecording, {
      useDelays: elements.useDelayCheckbox.checked
    }),
    "application/typescript"
  );
});

if (elements.copyCodeBtn) {
  elements.copyCodeBtn.addEventListener("click", safeHandler(async () => {
    const code = getCurrentCode();
    await navigator.clipboard.writeText(code);
    setStatus("Code copied to clipboard!", true);
  }));
}

elements.replayBtn.addEventListener("click", safeHandler(async () => {
  setStatus("Replaying...", true);

  renderCodeWithLines();
  buildAwaitLineMap();

  const displayedCode = getCurrentCode();

  function onProgress(info) {
    const codeLines = elements.codeOutput.querySelectorAll(".code-line");
    if (!codeLines.length) return;
    const stepIndex = info.index;
    if (stepIndex >= replayAwaitLineMap.length) return;
    const lineIdx = replayAwaitLineMap[stepIndex];
    const lineEl = codeLines[lineIdx];
    if (!lineEl) return;
    lineEl.classList.remove("line-running", "line-done", "line-skipped", "line-failed");
    if (info.status === "running") lineEl.classList.add("line-running");
    else if (info.status === "done") lineEl.classList.add("line-done");
    else if (info.status === "skipped") lineEl.classList.add("line-skipped");
    else if (info.status === "failed") lineEl.classList.add("line-failed");
    lineEl.scrollIntoView({ block: "nearest" });
  }

  const result = await crxPlayer.replayCode(displayedCode, {
    skipOnError: elements.skipOnErrorCheckbox.checked
  }, onProgress);

  if (result.ok && (!result.errors || result.errors.length === 0)) {
    setStatus(
      "Replay SUCCESS • " + result.completedSteps + "/" + result.stepCount + " steps at " + formatLocalTime(result.completedAt),
      true
    );
  } else if (result.errors && result.errors.length > 0 && result.completedSteps === result.stepCount) {
    const errDetails = result.errors.map(function (e) {
      return e.stepDescription + " (page: " + e.pageUrl + ")";
    }).join("\n");
    setStatus(
      "Replay DONE with " + result.errors.length + " skipped step(s):\n" + errDetails,
      true
    );
  } else {
    setStatus(
      "Replay FAILED — " + (result.errorMessage || "Unknown error"),
      true
    );
  }
}));

function addChatMessage(type, content) {
  const msg = document.createElement("div");
  msg.className = "chat-msg " + type;
  if (type === "ai" && content.includes("```")) {
    const codeMatch = content.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
    if (codeMatch) {
      const pre = document.createElement("pre");
      pre.textContent = codeMatch[1].trim();
      const textBefore = content.slice(0, content.indexOf("```")).trim();
      if (textBefore) {
        msg.appendChild(document.createTextNode(textBefore));
      }
      msg.appendChild(pre);
    } else {
      msg.textContent = content;
    }
  } else {
    msg.textContent = content;
  }
  elements.chatMessages.appendChild(msg);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  return msg;
}

function addStatusMessage(text) {
  const msg = document.createElement("div");
  msg.className = "chat-msg ai-status";
  const dot = document.createElement("span");
  dot.className = "dot-pulse";
  dot.textContent = "●";
  msg.appendChild(dot);
  msg.appendChild(document.createTextNode(" " + text));
  elements.chatMessages.appendChild(msg);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  return msg;
}

function isScenarioRequest(prompt, code) {
  const scenarioKeywords = [
    "시나리오", "scenario", "만들어", "생성", "create",
    "테스트 작성", "test 작성", "자동화", "automate",
    "접속해서", "가서", "열어서", "들어가서",
    "로그인", "회원가입", "검색", "구매", "결제",
    "navigate", "go to", "visit", "open"
  ];
  const promptLower = prompt.toLowerCase();
  const hasKeyword = scenarioKeywords.some(function (kw) {
    return promptLower.includes(kw.toLowerCase());
  });
  const codeIsEmpty = !code || code.trim() === "" || /^import.*\ntest\(.*\{\n\}\);?\s*$/s.test(code.trim());
  return hasKeyword && codeIsEmpty;
}

function extractUrlFromPrompt(prompt) {
  const urlMatch = prompt.match(/https?:\/\/[^\s,)}\]]+/);
  return urlMatch ? urlMatch[0] : "";
}

async function sendAiScenario(prompt, url) {
  const response = await fetch("http://localhost:3100/api/ai-scenario", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, url })
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || "AI scenario request failed");
  }
  if (typeof data.code !== "string") {
    throw new Error("AI returned invalid response");
  }
  return data.code;
}

async function sendAiPrompt(prompt, code) {
  const response = await fetch("http://localhost:3100/api/ai-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, code })
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || "AI request failed");
  }
  if (typeof data.code !== "string") {
    throw new Error("AI returned invalid response");
  }
  return data.code;
}

function getCurrentCode() {
  const lineContents = elements.codeOutput.querySelectorAll(".line-content");
  if (lineContents.length) {
    return Array.from(lineContents).map(function (el) { return el.textContent; }).join("\n");
  }
  const chatCodeLines = elements.codeOutput.querySelectorAll(".code-line");
  if (chatCodeLines.length) {
    return Array.from(chatCodeLines).map(function (el) { return el.textContent; }).join("\n");
  }
  return elements.codeOutput.innerText || elements.codeOutput.textContent || generator.generatePlaywrightCode(currentRecording, {
    useDelays: elements.useDelayCheckbox.checked
  });
}

function applyAiResult(resultCode) {
  const isCode = /^\s*(import\s|test\s*\(|const\s|await\s)/.test(resultCode);

  if (isCode) {
    const aiMsg = addChatMessage("ai", "");
    const pre = document.createElement("pre");
    pre.textContent = resultCode;
    aiMsg.appendChild(pre);

    renderCodeLines(resultCode);
    setStatus("AI code updated", true);
  } else {
    addChatMessage("ai", resultCode);
    setStatus("AI responded", true);
  }
}

async function processAiRequest(prompt, code) {
  aiProcessing = true;
  const useScenario = isScenarioRequest(prompt, code);
  const statusMsg = addStatusMessage(
    useScenario
      ? "AI가 브라우저를 조작하며 시나리오를 생성하고 있습니다..."
      : "AI가 코드를 분석하고 있습니다..."
  );

  try {
    const resultCode = useScenario
      ? await sendAiScenario(prompt, extractUrlFromPrompt(prompt))
      : await sendAiPrompt(prompt, code);
    statusMsg.remove();
    applyAiResult(resultCode);

    while (btwQueue.length > 0) {
      const btwMsg = btwQueue.shift();
      const btwStatus = addStatusMessage("AI가 추가 요청을 처리하고 있습니다...");
      try {
        const btwResult = await sendAiPrompt(btwMsg, getCurrentCode());
        btwStatus.remove();
        applyAiResult(btwResult);
      } catch (err) {
        btwStatus.remove();
        addChatMessage("ai", "Error: " + err.message);
      }
    }
  } catch (err) {
    statusMsg.remove();
    addChatMessage("ai", "Error: " + err.message);
  } finally {
    aiProcessing = false;
  }
}

elements.aiPromptBtn.addEventListener("click", safeHandler(async () => {
  const rawPrompt = elements.aiPromptInput.value.trim();
  if (!rawPrompt) {
    return;
  }

  elements.aiPromptInput.value = "";

  if (aiProcessing) {
    const btwText = rawPrompt.startsWith("/btw ") ? rawPrompt.slice(5) : rawPrompt;
    btwQueue.push(btwText);
    addChatMessage("user", "/btw " + btwText);
    setStatus("Queued: will send after current AI response", true);
    return;
  }

  addChatMessage("user", rawPrompt);
  await processAiRequest(rawPrompt, getCurrentCode());
}));

elements.aiPromptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.aiPromptBtn.click();
  }
});

elements.aiPromptInput.addEventListener("input", () => {
  elements.aiPromptInput.style.height = "auto";
  elements.aiPromptInput.style.height = Math.min(elements.aiPromptInput.scrollHeight, 120) + "px";
});

let replayAwaitLineMap = [];

function buildAwaitLineMap() {
  replayAwaitLineMap = [];
  const lineContents = elements.codeOutput.querySelectorAll(".line-content");
  lineContents.forEach(function (content, i) {
    if (content.textContent.trim().startsWith("await ")) {
      replayAwaitLineMap.push(i);
    }
  });
}


function formatCode(code) {
  var lines = code.split("\n");
  var formatted = [];
  var depth = 0;
  var inBlockComment = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();

    if (!line) {
      if (formatted.length > 0 && formatted[formatted.length - 1] !== "") {
        formatted.push("");
      }
      continue;
    }

    if (inBlockComment) {
      formatted.push("  ".repeat(depth) + line);
      if (line.includes("*/")) { inBlockComment = false; }
      continue;
    }

    if (line.startsWith("/*")) {
      formatted.push("  ".repeat(depth) + line);
      if (!line.includes("*/")) { inBlockComment = true; }
      continue;
    }

    var isComment = line.startsWith("//");

    if (!isComment && (/^[}\])];?\s*$/.test(line) || /^\}\);?\s*$/.test(line))) {
      depth = Math.max(0, depth - 1);
    }

    formatted.push("  ".repeat(depth) + line);

    if (!isComment && /[\{\(]\s*$/.test(line)) {
      depth += 1;
    }
  }

  while (formatted.length > 0 && formatted[formatted.length - 1] === "") {
    formatted.pop();
  }

  return formatted.join("\n") + "\n";
}

elements.formatCodeBtn.addEventListener("click", function () {
  var code = getCurrentCode();
  var result = formatCode(code);
  renderCodeLines(result);
  setStatus("Code formatted");
});

function renderCodeWithLines() {
  const text = getCurrentCode();
  renderCodeLines(text);
}

refreshRecorderState();
startStateSync();
renderRecordingToggle();
renderOutputs();

window.addEventListener("unload", () => {
  stopLiveSync();
  stopStateSync();
});
