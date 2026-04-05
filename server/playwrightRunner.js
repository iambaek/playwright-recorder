const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium, firefox, webkit } = require("playwright");
const { generatePlaywrightCode, normalizeRecordingToSteps, sanitizeEvents } = require("../shared/playwright-generator");
const { executeStep } = require("../shared/stepExecutor");

const browserMap = { chromium, firefox, webkit };
const activeBrowsers = new Set();
let lastTracePath = null;
let lastRunSummary = null;
const sharedSessions = new Map();
const DEFAULT_ACTION_TIMEOUT_MS = 10000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15000;
const DEFAULT_MAX_DELAY_MS = 5000;

function resolveBrowserName(options) {
  return browserMap[options.browserName] ? options.browserName : "chromium";
}

function isHeadless(options) {
  return options.headless !== false;
}

function sanitizeProfileName(profileName) {
  const normalized = String(profileName || "default").trim().toLowerCase();
  const safe = normalized.replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-");
  return safe || "default";
}

function getSessionKey(options = {}) {
  const browserName = resolveBrowserName(options);
  const headless = isHeadless(options);
  const profileName = sanitizeProfileName(options.profileName);
  return [browserName, profileName, headless ? "headless" : "headed"].join(":");
}

function trackBrowser(browser) {
  activeBrowsers.add(browser);
  browser.on("disconnected", () => {
    activeBrowsers.delete(browser);

    for (const [key, session] of sharedSessions.entries()) {
      if (session.browser === browser) {
        sharedSessions.delete(key);
      }
    }
  });
}

function createTracePath(options = {}) {
  const tracesDir = options.traceDir || path.join(process.cwd(), "recordings", "traces");
  const traceName = options.traceName || "trace-" + new Date().toISOString().replace(/[:.]/g, "-") + ".zip";
  fs.mkdirSync(tracesDir, { recursive: true });
  return path.join(tracesDir, traceName);
}

function getUserDataDir(options = {}) {
  const browserName = resolveBrowserName(options);
  const profileName = sanitizeProfileName(options.profileName);
  const dir = options.userDataDir || getProfileDir(browserName, profileName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getProfilesRootDir(browserName) {
  return path.join(os.tmpdir(), "playwright-recorder", "profiles", browserName);
}

function getProfileDir(browserName, profileName) {
  return path.join(getProfilesRootDir(browserName), profileName);
}

async function createSession(options) {
  const browserName = resolveBrowserName(options);
  const headless = isHeadless(options);
  const launcher = browserMap[browserName];
  const browser = await launcher.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  trackBrowser(browser);

  return { browser, browserName, context, headless, page };
}

async function createPersistentSession(options) {
  const browserName = resolveBrowserName(options);
  const headless = isHeadless(options);
  const launcher = browserMap[browserName];
  const userDataDir = getUserDataDir(options);
  const context = await launcher.launchPersistentContext(userDataDir, { headless });
  const browser = context.browser();
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  if (browser) {
    trackBrowser(browser);
  }

  return {
    browser, browserName, context, headless, page,
    persistent: true,
    profileName: sanitizeProfileName(options.profileName),
    userDataDir
  };
}

async function getSession(options = {}) {
  const sessionKey = getSessionKey(options);
  const browserName = resolveBrowserName(options);
  const headless = isHeadless(options);
  const userDataDir = getUserDataDir(options);
  const profileName = sanitizeProfileName(options.profileName);

  if (!options.reuseSession) {
    return {
      session: await createSession(options),
      reusable: false
    };
  }

  const sharedSession = sharedSessions.get(sessionKey);
  const needsNewSession =
    !sharedSession ||
    sharedSession.browserName !== browserName ||
    sharedSession.headless !== headless ||
    sharedSession.userDataDir !== userDataDir ||
    !sharedSession.browser ||
    sharedSession.browser.isConnected() === false;

  if (needsNewSession) {
    if (sharedSession) {
      await closeSharedSession({ sessionKey });
    }
    sharedSessions.set(
      sessionKey,
      await createPersistentSession({
        ...options,
        profileName
      })
    );
  }

  const session = sharedSessions.get(sessionKey);
  const pages = session.context.pages();
  session.page = pages[0] || (await session.context.newPage());

  return {
    session,
    reusable: true,
    sessionKey
  };
}

async function runRecording(recording, options = {}) {
  const keepOpen = options.keepOpen === true;
  const traceEnabled = options.trace !== false;
  const useDelays = options.useDelays === true;
  const actionTimeoutMs = Math.max(1000, Number(options.actionTimeoutMs) || DEFAULT_ACTION_TIMEOUT_MS);
  const navigationTimeoutMs = Math.max(1000, Number(options.navigationTimeoutMs) || DEFAULT_NAVIGATION_TIMEOUT_MS);
  const maxDelayMs = Math.max(0, Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS);
  const profileName = sanitizeProfileName(options.profileName);
  const { session, reusable, sessionKey } = await getSession({
    ...options,
    profileName
  });
  const { browser, context, page, browserName } = session;
  const events = sanitizeEvents(recording.events);
  const steps = normalizeRecordingToSteps(recording, {
    includeDelays: useDelays
  });
  const tracePath = traceEnabled ? createTracePath(options) : null;

  if (traceEnabled) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true
    });
  }

  context.setDefaultTimeout(actionTimeoutMs);
  context.setDefaultNavigationTimeout(navigationTimeoutMs);
  let completedSteps = 0;

  const stepOpts = { actionTimeoutMs, navigationTimeoutMs, maxDelayMs };

  try {
    for (let index = 0; index < steps.length; index += 1) {
      await executeStep(page, steps[index], stepOpts);
      completedSteps += 1;
    }
  } catch (error) {
    if (traceEnabled) {
      await context.tracing.stop({ path: tracePath });
      lastTracePath = tracePath;
    }
    if (reusable) {
      await closeSharedSession({ sessionKey });
    } else {
      await browser.close();
    }
    const failedStep = steps[completedSteps] || null;
    const target = failedStep ? failedStep.selector || failedStep.url || failedStep.type : "unknown";
    const failResult = {
      ok: false,
      eventCount: events.length,
      stepCount: steps.length,
      completedSteps,
      failedStepIndex: completedSteps,
      failedStepTarget: target,
      failedStepType: failedStep ? failedStep.type : "unknown",
      errorMessage: error.message,
      browserName,
      completedAt: new Date().toISOString(),
      keepOpen,
      profileName,
      reuseSession: reusable,
      useDelays: useDelays,
      tracePath
    };

    lastRunSummary = {
      result: failResult,
      recording
    };

    return failResult;
  }

  if (traceEnabled) {
    await context.tracing.stop({ path: tracePath });
    lastTracePath = tracePath;
  }

  if (!keepOpen && !reusable) {
    await browser.close();
  }

  const result = {
    ok: true,
    eventCount: events.length,
    stepCount: steps.length,
    completedSteps,
    browserName,
    completedAt: new Date().toISOString(),
    keepOpen,
    profileName,
    reuseSession: reusable,
    useDelays,
    tracePath
  };

  lastRunSummary = {
    result,
    recording
  };

  return result;
}

function loadRecordingFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const recording = JSON.parse(raw);

  return { absolutePath, recording };
}

function writePlaywrightFile(recording, outputPath, options = {}) {
  const absolutePath = path.resolve(outputPath);
  const code = generatePlaywrightCode(recording, options);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, code, "utf8");
  return absolutePath;
}

function getLastTracePath() {
  return lastTracePath;
}

function getLastRunSummary() {
  return lastRunSummary;
}

function getSharedSessionState() {
  return Array.from(sharedSessions.values()).map((session) => ({
    active: Boolean(session && session.browser && session.browser.isConnected()),
    browserName: session ? session.browserName : null,
    profileName: session ? session.profileName : null,
    userDataDir: session ? session.userDataDir : null
  }));
}

async function closeSharedSession(options = {}) {
  if (!options.sessionKey && options.profileName && options.headless === undefined) {
    const browserName = resolveBrowserName(options);
    const profileName = sanitizeProfileName(options.profileName);
    const closedHeaded = await closeSharedSession({
      sessionKey: getSessionKey({ browserName, profileName, headless: false })
    });
    const closedHeadless = await closeSharedSession({
      sessionKey: getSessionKey({ browserName, profileName, headless: true })
    });
    return closedHeaded || closedHeadless;
  }

  const sessionKey = options.sessionKey || getSessionKey(options);
  const sharedSession = sharedSessions.get(sessionKey);
  if (!sharedSession) {
    return false;
  }

  const { browser, context } = sharedSession;
  sharedSessions.delete(sessionKey);
  try {
    await context.tracing.stop().catch(() => {});
  } catch (_ignore) {}
  if (browser) {
    await browser.close();
    return true;
  }

  await context.close();
  return true;
}

function openTraceViewer(tracePath) {
  const absolutePath = path.resolve(tracePath);
  if (path.extname(absolutePath) !== ".zip") {
    throw new Error("Trace file must be a .zip file");
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error("Trace file does not exist: " + path.basename(absolutePath));
  }
  const child = spawn("npx", ["playwright", "show-trace", absolutePath], {
    stdio: "ignore",
    detached: true
  });
  child.unref();
  return absolutePath;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildReportHtml(summary) {
  const recording = summary.recording || { events: [] };
  const result = summary.result || {};
  const rows = (recording.events || [])
    .map((event, index) =>
      [
        "<tr>",
        "<td>" + (index + 1) + "</td>",
        "<td>" + escapeHtml(event.type || "") + "</td>",
        "<td>" + escapeHtml(event.url || event.selector || "") + "</td>",
        "<td>" + escapeHtml(event.value || event.key || event.text || "") + "</td>",
        "<td>" + escapeHtml(event.delayMs || 0) + " ms</td>",
        "</tr>"
      ].join("")
    )
    .join("\n");

  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Playwright Recorder Report</title>",
    "<style>",
    "body{font-family:IBM Plex Sans,Segoe UI,sans-serif;background:#f5f5f4;color:#1f2937;margin:0;padding:32px;}",
    ".wrap{max-width:1100px;margin:0 auto;}",
    ".hero{padding:24px;border-radius:20px;background:linear-gradient(135deg,#0f766e,#134e4a);color:#fff;box-shadow:0 20px 50px rgba(0,0,0,.15);}",
    ".grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0;}",
    ".card{background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:16px;}",
    ".label{font-size:12px;color:#78716c;text-transform:uppercase;letter-spacing:.08em;}",
    ".value{margin-top:8px;font-size:20px;font-weight:700;}",
    "table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e7e5e4;border-radius:16px;overflow:hidden;}",
    "th,td{padding:12px 14px;border-bottom:1px solid #e7e5e4;text-align:left;font-size:14px;vertical-align:top;}",
    "th{background:#fafaf9;color:#57534e;font-size:12px;text-transform:uppercase;letter-spacing:.08em;}",
    ".meta{margin-top:18px;color:#d1fae5;font-size:13px;}",
    "@media (max-width:800px){.grid{grid-template-columns:1fr 1fr;}}",
    "</style>",
    "</head>",
    "<body>",
    "<div class=\"wrap\">",
    "<div class=\"hero\">",
    "<h1>Playwright Recorder Report</h1>",
    "<div class=\"meta\">Generated at " + escapeHtml(new Date().toISOString()) + "</div>",
    "</div>",
    "<div class=\"grid\">",
    "<div class=\"card\"><div class=\"label\">Result</div><div class=\"value\" style=\"color:" + (result.ok ? "#16a34a" : "#dc2626") + "\">" + (result.ok ? "SUCCESS" : "FAILED") + "</div></div>",
    "<div class=\"card\"><div class=\"label\">Steps</div><div class=\"value\">" + escapeHtml((result.completedSteps || 0) + "/" + (result.stepCount || 0)) + "</div></div>",
    "<div class=\"card\"><div class=\"label\">Browser</div><div class=\"value\">" + escapeHtml(result.browserName || "chromium") + "</div></div>",
    "<div class=\"card\"><div class=\"label\">Profile</div><div class=\"value\">" + escapeHtml(result.profileName || "default") + "</div></div>",
    "</div>",
    "<table>",
    "<thead><tr><th>#</th><th>Type</th><th>Target</th><th>Value</th><th>Delay</th></tr></thead>",
    "<tbody>",
    rows,
    "</tbody>",
    "</table>",
    "</div>",
    "</body>",
    "</html>"
  ].join("");
}

function writeHtmlReport(summary, outputPath) {
  const absolutePath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, buildReportHtml(summary), "utf8");
  return absolutePath;
}

function getOpenCommand() {
  switch (process.platform) {
    case "darwin": return "open";
    case "win32": return "start";
    default: return "xdg-open";
  }
}

function openFileInBrowser(filePath) {
  const absolutePath = path.resolve(filePath);
  const cmd = getOpenCommand();
  const args = process.platform === "win32" ? ["", absolutePath] : [absolutePath];
  const child = spawn(cmd, args, {
    stdio: "ignore",
    detached: true,
    shell: process.platform === "win32"
  });
  child.unref();
  return absolutePath;
}

function listProfiles(options = {}) {
  const browserName = resolveBrowserName(options);
  const rootDir = getProfilesRootDir(browserName);
  fs.mkdirSync(rootDir, { recursive: true });
  ensureProfile({ browserName, profileName: "default" });

  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function ensureProfile(options = {}) {
  const profileName = sanitizeProfileName(options.profileName);
  const userDataDir = getUserDataDir({ ...options, profileName });
  return {
    profileName,
    userDataDir
  };
}

async function deleteProfile(options = {}) {
  const browserName = resolveBrowserName(options);
  const profileName = sanitizeProfileName(options.profileName);
  const sessionKey = getSessionKey({
    browserName,
    profileName,
    headless: false
  });
  const headlessSessionKey = getSessionKey({
    browserName,
    profileName,
    headless: true
  });

  await closeSharedSession({ sessionKey });
  await closeSharedSession({ sessionKey: headlessSessionKey });

  const userDataDir = getProfileDir(browserName, profileName);
  if (!fs.existsSync(userDataDir)) {
    return false;
  }

  fs.rmSync(userDataDir, { recursive: true, force: true });
  return true;
}

module.exports = {
  activeBrowsers,
  deleteProfile,
  ensureProfile,
  closeSharedSession,
  getLastRunSummary,
  getLastTracePath,
  getSharedSessionState,
  listProfiles,
  loadRecordingFile,
  openFileInBrowser,
  openTraceViewer,
  runRecording,
  writeHtmlReport,
  writePlaywrightFile
};
