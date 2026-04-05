const sessions = new Map();
const idleIconPaths = {
  16: "icons/idle-icon-16.png",
  32: "icons/idle-icon-32.png",
  48: "icons/idle-icon-48.png",
  128: "icons/idle-icon-128.png"
};
const recordingIconPaths = {
  16: "icons/recording-icon-16.png",
  32: "icons/recording-icon-32.png",
  48: "icons/recording-icon-48.png",
  128: "icons/recording-icon-128.png"
};
const DEFAULT_SETTINGS = {
  openSidePanelOnActionClick: true
};
let attachedTabId = null;
const childToParentTab = new Map();
const inspectStateByTab = new Map();
const CONTEXT_MENU_OPEN = "playwright-recorder-open-panel";
const CONTEXT_MENU_ATTACH = "playwright-recorder-attach-tab";
const CONTEXT_MENU_DETACH = "playwright-recorder-detach-tab";
const CONTEXT_MENU_TOGGLE = "playwright-recorder-toggle-recording";

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
      events: []
    });
  }

  return sessions.get(tabId);
}

function getInspectState(tabId) {
  if (!inspectStateByTab.has(tabId)) {
    inspectStateByTab.set(tabId, {
      enabled: false,
      hoveredSelector: "",
      pickedSelector: "",
      frameSelectors: []
    });
  }

  return inspectStateByTab.get(tabId);
}

async function sendInspectModeToAllFrames(tabId, enabled) {
  if (tabId == null) {
    return;
  }

  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) {
    await chrome.tabs.sendMessage(tabId, {
      type: "SET_INSPECT_MODE",
      enabled
    }).catch(() => {});
    return;
  }

  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  if (!Array.isArray(frames) || !frames.length) {
    await chrome.tabs.sendMessage(tabId, {
      type: "SET_INSPECT_MODE",
      enabled
    }).catch(() => {});
    return;
  }

  await Promise.all(
    frames.map((frame) =>
      chrome.tabs
        .sendMessage(tabId, {
          type: "SET_INSPECT_MODE",
          enabled
        }, {
          frameId: frame.frameId
        })
        .catch(() => {})
    )
  );
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function makeRecordingPayload(session) {
  return {
    startedAt: session.startedAt,
    stoppedAt: session.recording ? null : Date.now(),
    events: session.events
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

async function attachTab(tab) {
  if (!tab || tab.id == null) {
    return null;
  }

  attachedTabId = tab.id;
  return {
    tabId: tab.id,
    title: tab.title || "",
    url: tab.url || ""
  };
}

async function detachTab() {
  const tabId = attachedTabId;
  attachedTabId = null;
  return tabId;
}

async function getAttachedTabInfo() {
  if (attachedTabId == null) {
    return null;
  }

  try {
    const tab = await chrome.tabs.get(attachedTabId);
    return {
      id: tab.id,
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || ""
    };
  } catch (_error) {
    attachedTabId = null;
    return null;
  }
}

function createInitialRecording(initialUrl) {
  return initialUrl
    ? [
        {
          type: "navigation",
          url: initialUrl,
          timestamp: Date.now(),
          delayMs: 0
        }
      ]
    : [];
}

async function startRecordingForTab(tab) {
  if (!tab || tab.id == null) {
    return null;
  }

  const session = getSession(tab.id);
  session.recording = true;
  session.startedAt = Date.now();
  session.events = createInitialRecording(tab.url);
  await updateActionIcon(tab.id, true).catch(() => {});
  return session;
}

async function stopRecordingForTab(tabId) {
  if (tabId == null) {
    return null;
  }

  const session = getSession(tabId);
  session.recording = false;
  await updateActionIcon(tabId, false).catch(() => {});
  return makeRecordingPayload(session);
}

async function toggleRecordingForTab(tab) {
  if (!tab || tab.id == null) {
    return null;
  }

  const session = getSession(tab.id);
  if (session.recording) {
    return {
      recording: false,
      recordingData: await stopRecordingForTab(tab.id)
    };
  }

  const started = await startRecordingForTab(tab);
  return {
    recording: true,
    session: started
  };
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_OPEN,
      title: "Open Recorder Panel",
      contexts: ["action", "page"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ATTACH,
      title: "Attach This Tab",
      contexts: ["action", "page"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_DETACH,
      title: "Detach Attached Tab",
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
  if (message.type === "START_RECORDING") {
    const tabId = message.tabId;
    const session = getSession(tabId);
    session.recording = true;
    session.startedAt = Date.now();
    session.events = createInitialRecording(message.initialUrl);
    attachedTabId = tabId;
    updateActionIcon(tabId, true).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: "SET_RECORDING_STATE", recording: true }).catch(() => {});
    sendResponse({ ok: true, session });
    return true;
  }

  if (message.type === "STOP_RECORDING") {
    const tabId = message.tabId;
    const session = getSession(tabId);
    session.recording = false;
    updateActionIcon(tabId, false).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: "SET_RECORDING_STATE", recording: false }).catch(() => {});
    sendResponse({
      ok: true,
      recording: makeRecordingPayload(session)
    });
    return true;
  }

  if (message.type === "ATTACH_TAB") {
    chrome.tabs.get(message.tabId, async (tab) => {
      const attached = await attachTab(tab);
      sendResponse({ ok: true, attachedTab: attached });
    });
    return true;
  }

  if (message.type === "DETACH_TAB") {
    detachTab()
      .then((tabId) => {
        sendResponse({ ok: true, detachedTabId: tabId });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "GET_RECORDER_META") {
    getAttachedTabInfo()
      .then((attachedTab) => {
        const inspect = attachedTab && attachedTab.tabId != null ? getInspectState(attachedTab.tabId) : null;
        sendResponse({
          ok: true,
          attachedTab,
          inspect
        });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "GET_STATE") {
    const tabId = message.tabId;
    const session = getSession(tabId);
    const inspect = getInspectState(tabId);
    sendResponse({
      ok: true,
      recording: session.recording,
      eventCount: session.events.length,
      startedAt: session.startedAt,
      attached: attachedTabId === tabId,
      inspectMode: inspect.enabled
    });
    return true;
  }

  if (message.type === "GET_RECORDING") {
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

    // Check direct mapping first
    if (childToParentTab.has(senderTabId)) {
      const parentId = childToParentTab.get(senderTabId);
      const session = getSession(parentId);
      sendResponse({ ok: true, recording: session.recording });
      return true;
    }

    // Check own session
    const ownSession = sessions.get(senderTabId);
    if (ownSession) {
      sendResponse({ ok: true, recording: ownSession.recording });
      return true;
    }

    // Check openerTabId for popup windows
    chrome.tabs.get(senderTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ ok: true, recording: false });
        return;
      }
      if (tab.openerTabId != null) {
        const parentSession = sessions.get(tab.openerTabId);
        if (parentSession && parentSession.recording) {
          childToParentTab.set(senderTabId, tab.openerTabId);
          sendResponse({ ok: true, recording: true });
          return;
        }
      }
      sendResponse({ ok: true, recording: false });
    });
    return true;
  }

  if (message.type === "RECORDED_EVENT" && sender.tab && sender.tab.id != null) {
    const senderTabId = sender.tab.id;
    const targetTabId = childToParentTab.has(senderTabId) ? childToParentTab.get(senderTabId) : senderTabId;
    const session = getSession(targetTabId);
    if (!session.recording) {
      sendResponse({ ok: false, ignored: true });
      return true;
    }

    pushRecordedEvent(session, message.event);
    sendResponse({ ok: true, count: session.events.length });
    return true;
  }

  if (message.type === "SET_INSPECT_MODE") {
    const tabId = message.tabId;
    const inspect = getInspectState(tabId);
    inspect.enabled = Boolean(message.enabled);
    if (!inspect.enabled) {
      inspect.hoveredSelector = "";
    }
    sendInspectModeToAllFrames(tabId, inspect.enabled).catch(() => {});
    sendResponse({ ok: true, inspect });
    return true;
  }

  if (message.type === "INSPECT_HOVER" && sender.tab && sender.tab.id != null) {
    const inspect = getInspectState(sender.tab.id);
    inspect.hoveredSelector = message.selector || "";
    inspect.frameSelectors = Array.isArray(message.frameSelectors) ? message.frameSelectors : [];
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "INSPECT_PICK" && sender.tab && sender.tab.id != null) {
    const inspect = getInspectState(sender.tab.id);
    inspect.pickedSelector = message.selector || "";
    inspect.frameSelectors = Array.isArray(message.frameSelectors) ? message.frameSelectors : [];
    sendResponse({ ok: true, inspect });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  inspectStateByTab.delete(tabId);
  childToParentTab.delete(tabId);
  if (attachedTabId === tabId) {
    attachedTabId = null;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) {
    return;
  }

  // If this is a child popup tab, notify its content script to start recording
  if (childToParentTab.has(tabId)) {
    chrome.tabs.sendMessage(tabId, { type: "SET_RECORDING_STATE", recording: true }).catch(() => {});
  }

  const targetTabId = childToParentTab.has(tabId) ? childToParentTab.get(tabId) : tabId;
  const session = getSession(targetTabId);
  if (!session.recording) {
    return;
  }

  const lastEvent = session.events[session.events.length - 1];
  if (lastEvent && lastEvent.type === "navigation" && lastEvent.url === tab.url) {
    return;
  }

  pushRecordedEvent(session, makeNavigationEvent(tab));
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const session = sessions.get(tabId);
  await updateActionIcon(tabId, Boolean(session && session.recording)).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel().catch(() => {});
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel().catch(() => {});
  createContextMenus();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  if (changes.openSidePanelOnActionClick) {
    configureSidePanel().catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetTab = tab || (await getActiveTab());
  if (!targetTab) {
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_OPEN) {
    await openRecorderPanel(targetTab).catch(() => {});
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_ATTACH) {
    await attachTab(targetTab);
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_DETACH) {
    await detachTab();
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_TOGGLE) {
    const baseTab = (await getAttachedTabInfo()) || targetTab;
    await toggleRecordingForTab(baseTab).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const activeTab = await getActiveTab();
  const attachedTab = await getAttachedTabInfo();
  const targetTab = attachedTab || activeTab;

  if (command === "open-recorder-panel" && activeTab) {
    await openRecorderPanel(activeTab).catch(() => {});
    return;
  }

  if (command === "attach-current-tab" && activeTab) {
    await attachTab(activeTab);
    return;
  }

  if (command === "toggle-recording" && targetTab) {
    await toggleRecordingForTab(targetTab).catch(() => {});
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  const parentSession = sessions.get(tab.openerTabId);
  if (parentSession && parentSession.recording) {
    childToParentTab.set(tab.id, tab.openerTabId);
  }
});

configureSidePanel().catch(() => {});
createContextMenus();
