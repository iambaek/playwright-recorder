var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// extension/src/background.js
var require_background = __commonJS({
  "extension/src/background.js"() {
    var sessions = /* @__PURE__ */ new Map();
    var idleIconPaths = {
      16: "icons/idle-icon-16.png",
      32: "icons/idle-icon-32.png",
      48: "icons/idle-icon-48.png",
      128: "icons/idle-icon-128.png"
    };
    var recordingIconPaths = {
      16: "icons/recording-icon-16.png",
      32: "icons/recording-icon-32.png",
      48: "icons/recording-icon-48.png",
      128: "icons/recording-icon-128.png"
    };
    var DEFAULT_SETTINGS = {
      openSidePanelOnActionClick: true
    };
    var childToParentTab = /* @__PURE__ */ new Map();
    var CONTEXT_MENU_OPEN = "playwright-recorder-open-panel";
    var CONTEXT_MENU_TOGGLE = "playwright-recorder-toggle-recording";
    async function configureSidePanel() {
      if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) {
        return;
      }
      const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      await chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: settings.openSidePanelOnActionClick
      });
    }
    async function updateActionIcon(tabId, isRecording) {
      if (tabId == null || !chrome.action || !chrome.action.setIcon) {
        return;
      }
      await chrome.action.setIcon({
        tabId,
        path: isRecording ? recordingIconPaths : idleIconPaths
      });
    }
    function getSession(tabId) {
      if (!sessions.has(tabId)) {
        sessions.set(tabId, {
          recording: false,
          startedAt: null,
          events: [],
          networkRequests: [],
          consoleLogs: [],
          debuggerAttached: false
        });
      }
      return sessions.get(tabId);
    }
    async function attachDebugger(tabId) {
      const session = getSession(tabId);
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        session.debuggerAttached = true;
        await chrome.debugger.sendCommand({ tabId }, "Network.enable", {});
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
        await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
        console.log("[CDP] Debugger attached to tab", tabId);
      } catch (error) {
        console.log("[CDP] Failed to attach:", error.message);
        session.debuggerAttached = false;
      }
    }
    async function detachDebugger(tabId) {
      const session = getSession(tabId);
      if (!session.debuggerAttached) return;
      try {
        await chrome.debugger.detach({ tabId });
        console.log("[CDP] Debugger detached from tab", tabId);
      } catch (_error) {
      }
      session.debuggerAttached = false;
    }
    chrome.debugger.onEvent.addListener(function(source, method, params) {
      const tabId = source.tabId;
      if (tabId == null) return;
      const session = sessions.get(tabId);
      if (!session || !session.recording) return;
      if (method === "Network.requestWillBeSent") {
        const req = params.request;
        if (!req || !req.url) return;
        if (req.url.startsWith("data:") || req.url.startsWith("chrome-extension:")) return;
        session.networkRequests.push({
          timestamp: Date.now(),
          method: req.method,
          url: req.url,
          type: params.type || "",
          requestId: params.requestId
        });
      }
      if (method === "Network.responseReceived") {
        const resp = params.response;
        if (!resp) return;
        const existing = session.networkRequests.find(function(r) {
          return r.requestId === params.requestId;
        });
        if (existing) {
          existing.status = resp.status;
          existing.statusText = resp.statusText || "";
          existing.mimeType = resp.mimeType || "";
        }
      }
      if (method === "Runtime.consoleAPICalled") {
        const args = (params.args || []).map(function(arg) {
          return arg.value !== void 0 ? String(arg.value) : arg.description || arg.type;
        });
        session.consoleLogs.push({
          timestamp: Date.now(),
          level: params.type || "log",
          text: args.join(" ")
        });
      }
    });
    chrome.debugger.onDetach.addListener(function(source, reason) {
      const tabId = source.tabId;
      if (tabId == null) return;
      const session = sessions.get(tabId);
      if (session) {
        session.debuggerAttached = false;
        console.log("[CDP] Debugger detached by", reason, "from tab", tabId);
      }
    });
    async function getActiveTab() {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0] || null;
    }
    function makeRecordingPayload(session) {
      return {
        startedAt: session.startedAt,
        stoppedAt: session.recording ? null : Date.now(),
        events: session.events,
        networkRequests: session.networkRequests || [],
        consoleLogs: session.consoleLogs || []
      };
    }
    async function openRecorderPanel(tab) {
      if (!chrome.sidePanel || !chrome.sidePanel.open || !tab) {
        return false;
      }
      await chrome.sidePanel.open({
        tabId: tab.id,
        windowId: tab.windowId
      });
      return true;
    }
    function createInitialRecording(initialUrl) {
      return initialUrl ? [
        {
          type: "navigation",
          url: initialUrl,
          timestamp: Date.now(),
          delayMs: 0
        }
      ] : [];
    }
    async function toggleRecordingForTab(tab) {
      if (!tab || tab.id == null) {
        return null;
      }
      const session = getSession(tab.id);
      if (session.recording) {
        session.recording = false;
        await updateActionIcon(tab.id, false).catch(() => {
        });
        chrome.tabs.sendMessage(tab.id, { type: "SET_RECORDING_STATE", recording: false }).catch(() => {
        });
        return { recording: false, recordingData: makeRecordingPayload(session) };
      }
      session.recording = true;
      session.startedAt = Date.now();
      session.events = createInitialRecording(tab.url);
      await updateActionIcon(tab.id, true).catch(() => {
      });
      chrome.tabs.sendMessage(tab.id, { type: "SET_RECORDING_STATE", recording: true }).catch(() => {
      });
      return { recording: true, session };
    }
    function createContextMenus() {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
          id: CONTEXT_MENU_OPEN,
          title: "Open Recorder Panel",
          contexts: ["action", "page"]
        });
        chrome.contextMenus.create({
          id: CONTEXT_MENU_TOGGLE,
          title: "Toggle Recording",
          contexts: ["action", "page"]
        });
      });
    }
    function makeNavigationEvent(tab) {
      return {
        type: "navigation",
        url: tab.url,
        title: tab.title || "",
        timestamp: Date.now()
      };
    }
    function pushRecordedEvent(session, event) {
      const lastEvent = session.events[session.events.length - 1];
      const baseTimestamp = lastEvent ? lastEvent.timestamp : session.startedAt || event.timestamp || Date.now();
      const timestamp = event.timestamp || Date.now();
      session.events.push({
        ...event,
        timestamp,
        delayMs: Math.max(0, timestamp - baseTimestamp)
      });
    }
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const fromExtensionPage = !sender.tab;
      if (message.type === "START_RECORDING") {
        if (!fromExtensionPage) return false;
        const tabId = message.tabId;
        const session = getSession(tabId);
        session.recording = true;
        session.startedAt = Date.now();
        session.events = createInitialRecording(message.initialUrl);
        session.networkRequests = [];
        session.consoleLogs = [];
        updateActionIcon(tabId, true).catch(() => {
        });
        chrome.tabs.sendMessage(tabId, { type: "SET_RECORDING_STATE", recording: true }).catch(() => {
        });
        attachDebugger(tabId).then(() => sendResponse({ ok: true, session }));
        return true;
      }
      if (message.type === "STOP_RECORDING") {
        if (!fromExtensionPage) return false;
        const tabId = message.tabId;
        const session = getSession(tabId);
        session.recording = false;
        updateActionIcon(tabId, false).catch(() => {
        });
        chrome.tabs.sendMessage(tabId, { type: "SET_RECORDING_STATE", recording: false }).catch(() => {
        });
        detachDebugger(tabId).then(() => {
          console.log("[CDP] Network requests:", session.networkRequests.length, "Console logs:", session.consoleLogs.length);
          sendResponse({
            ok: true,
            recording: makeRecordingPayload(session)
          });
        });
        return true;
      }
      if (message.type === "GET_STATE") {
        if (!fromExtensionPage) return false;
        const tabId = message.tabId;
        const session = getSession(tabId);
        sendResponse({
          ok: true,
          recording: session.recording,
          eventCount: session.events.length,
          startedAt: session.startedAt
        });
        return true;
      }
      if (message.type === "GET_RECORDING") {
        if (!fromExtensionPage) return false;
        const tabId = message.tabId;
        const session = getSession(tabId);
        sendResponse({
          ok: true,
          recording: makeRecordingPayload(session)
        });
        return true;
      }
      if (message.type === "QUERY_RECORDING_STATE" && sender.tab && sender.tab.id != null) {
        const senderTabId = sender.tab.id;
        if (childToParentTab.has(senderTabId)) {
          const parentSession = getSession(childToParentTab.get(senderTabId));
          sendResponse({ ok: true, recording: parentSession.recording });
          return true;
        }
        const ownSession = sessions.get(senderTabId);
        if (ownSession && ownSession.recording) {
          sendResponse({ ok: true, recording: true });
          return true;
        }
        for (const [parentTabId, session] of sessions.entries()) {
          if (session.recording && parentTabId !== senderTabId) {
            childToParentTab.set(senderTabId, parentTabId);
            sendResponse({ ok: true, recording: true });
            return true;
          }
        }
        sendResponse({ ok: true, recording: false });
        return true;
      }
      if (message.type === "RECORDED_EVENT" && sender.tab && sender.tab.id != null) {
        const senderTabId = sender.tab.id;
        const isPopup = childToParentTab.has(senderTabId);
        const targetTabId = isPopup ? childToParentTab.get(senderTabId) : senderTabId;
        const session = getSession(targetTabId);
        if (!session.recording) {
          sendResponse({ ok: false, ignored: true });
          return true;
        }
        const event = isPopup ? { ...message.event, isPopup: true } : message.event;
        pushRecordedEvent(session, event);
        sendResponse({ ok: true, count: session.events.length });
        return true;
      }
      return false;
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      sessions.delete(tabId);
      childToParentTab.delete(tabId);
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status !== "complete" || !tab.url) {
        return;
      }
      if (childToParentTab.has(tabId)) {
        chrome.tabs.sendMessage(tabId, { type: "SET_RECORDING_STATE", recording: true }).catch(() => {
        });
      }
      const isPopup = childToParentTab.has(tabId);
      const targetTabId = isPopup ? childToParentTab.get(tabId) : tabId;
      const session = getSession(targetTabId);
      if (!session.recording) {
        return;
      }
      const lastEvent = session.events[session.events.length - 1];
      if (lastEvent && lastEvent.type === "navigation" && lastEvent.url === tab.url) {
        return;
      }
      const navEvent = makeNavigationEvent(tab);
      if (isPopup) {
        navEvent.isPopup = true;
      }
      pushRecordedEvent(session, navEvent);
    });
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
      const session = sessions.get(tabId);
      await updateActionIcon(tabId, Boolean(session && session.recording)).catch(() => {
      });
    });
    chrome.runtime.onInstalled.addListener(() => {
      configureSidePanel().catch(() => {
      });
      createContextMenus();
    });
    chrome.runtime.onStartup.addListener(() => {
      configureSidePanel().catch(() => {
      });
      createContextMenus();
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }
      if (changes.openSidePanelOnActionClick) {
        configureSidePanel().catch(() => {
        });
      }
    });
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      const targetTab = tab || await getActiveTab();
      if (!targetTab) {
        return;
      }
      if (info.menuItemId === CONTEXT_MENU_OPEN) {
        await openRecorderPanel(targetTab).catch(() => {
        });
        return;
      }
      if (info.menuItemId === CONTEXT_MENU_TOGGLE) {
        await toggleRecordingForTab(targetTab).catch(() => {
        });
      }
    });
    chrome.commands.onCommand.addListener(async (command) => {
      const activeTab = await getActiveTab();
      if (!activeTab) {
        return;
      }
      if (command === "open-recorder-panel") {
        await openRecorderPanel(activeTab).catch(() => {
        });
        return;
      }
      if (command === "toggle-recording") {
        await toggleRecordingForTab(activeTab).catch(() => {
        });
      }
    });
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.openerTabId != null) {
        const parentSession = sessions.get(tab.openerTabId);
        if (parentSession && parentSession.recording) {
          childToParentTab.set(tab.id, tab.openerTabId);
          pushRecordedEvent(parentSession, { type: "popup_opened", timestamp: Date.now() });
          return;
        }
      }
      for (const [parentTabId, session] of sessions.entries()) {
        if (session.recording) {
          childToParentTab.set(tab.id, parentTabId);
          pushRecordedEvent(session, { type: "popup_opened", timestamp: Date.now() });
          return;
        }
      }
    });
    configureSidePanel().catch(() => {
    });
    createContextMenus();
  }
});
export default require_background();
