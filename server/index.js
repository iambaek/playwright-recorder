const path = require("path");
const express = require("express");
const {
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
} = require("./playwrightRunner");

const PORT = process.env.PORT || 3100;
const MAX_CONVERSATION_HISTORY = 20;
const MAX_PROMPT_LENGTH = 10000;
const MAX_CODE_LENGTH = 100000;

function isValidHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_e) {
    return false;
  }
}

function safeResolvePath(rawPath, allowedDir) {
  const resolved = path.resolve(rawPath);
  if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) {
    return null;
  }
  // Resolve symlinks on the nearest existing ancestor to prevent traversal
  let check = path.dirname(resolved);
  try {
    const real = require("fs").realpathSync(check);
    if (!real.startsWith(allowedDir)) return null;
  } catch (_e) {
    // Ancestor doesn't exist yet — path.resolve check above is sufficient
  }
  return resolved;
}

const ALLOWED_ORIGIN_PATTERN = /^chrome-extension:\/\//;

function createServer() {
  const app = express();
  app.use(function allowCors(req, res, next) {
    const origin = req.headers.origin || "";
    if (ALLOWED_ORIGIN_PATTERN.test(origin) || origin === "http://localhost:3100") {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    next();
  });
  app.options("*", function preflight(_req, res) {
    res.sendStatus(204);
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", function health(_req, res) {
    res.json({
      ok: true,
      openBrowsers: activeBrowsers.size,
      lastTracePath: getLastTracePath(),
      sharedSession: getSharedSessionState()
    });
  });

  app.get("/api/profiles", function profiles(req, res) {
    try {
      const browserName = req.query.browserName || "chromium";
      const profiles = listProfiles({ browserName });
      res.json({ ok: true, profiles });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/profiles", function createProfile(req, res) {
    try {
      const browserName = (req.body && req.body.browserName) || "chromium";
      const profileName = req.body && req.body.profileName;
      if (!profileName) {
        res.status(400).json({ ok: false, error: "profileName is required" });
        return;
      }

      const result = ensureProfile({ browserName, profileName });
      res.json({ ok: true, ...result, profiles: listProfiles({ browserName }) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.delete("/api/profiles/:profileName", async function removeProfile(req, res) {
    try {
      const browserName = req.query.browserName || "chromium";
      const deleted = await deleteProfile({
        browserName,
        profileName: req.params.profileName
      });
      res.json({ ok: true, deleted, profiles: listProfiles({ browserName }) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/replay", async function replay(req, res) {
    try {
      const recording = req.body && req.body.recording ? req.body.recording : null;
      if (!recording || !Array.isArray(recording.events)) {
        res.status(400).json({ ok: false, error: "Invalid recording payload" });
        return;
      }

      const result = await runRecording(recording, req.body.options || {});
      res.json(result);
    } catch (error) {
      res.json({ ok: false, errorMessage: error.message, completedAt: new Date().toISOString() });
    }
  });

  app.post("/api/show-trace", function showTrace(req, res) {
    try {
      const tracePath = (req.body && req.body.tracePath) || getLastTracePath();
      if (!tracePath) {
        res.status(400).json({ ok: false, error: "No trace file available" });
        return;
      }

      const openedPath = openTraceViewer(tracePath);
      res.json({ ok: true, tracePath: openedPath });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/show-report", function showReport(req, res) {
    try {
      const summary = getLastRunSummary();
      if (!summary) {
        res.status(400).json({ ok: false, error: "No replay report available" });
        return;
      }

      const reportsDir = path.join(process.cwd(), "recordings", "reports");
      const rawOutput = (req.body && req.body.outputPath) || path.join(reportsDir, "latest-report.html");
      const resolvedOutput = safeResolvePath(rawOutput, path.join(process.cwd(), "recordings"));
      if (!resolvedOutput) {
        res.status(400).json({ ok: false, error: "Output path must be inside recordings/" });
        return;
      }
      const reportPath = writeHtmlReport(summary, resolvedOutput);
      const openedPath = openFileInBrowser(reportPath);
      res.json({ ok: true, reportPath: openedPath });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  const scenarioHistory = [];

  app.post("/api/ai-scenario", function aiScenario(req, res) {
    const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt.slice(0, MAX_PROMPT_LENGTH) : "";
    const rawUrl = req.body && typeof req.body.url === "string" ? req.body.url.slice(0, 2000) : "";
    const url = isValidHttpUrl(rawUrl) ? rawUrl : "";
    if (!prompt) {
      res.status(400).json({ ok: false, error: "prompt is required" });
      return;
    }
    if (rawUrl && !url) {
      res.status(400).json({ ok: false, error: "url must be a valid http/https URL" });
      return;
    }

    const systemInstruction = [
      "You are a Playwright test scenario creator.",
      "The user will describe a test scenario in natural language.",
      "You MUST use Playwright MCP tools to actually interact with the browser and perform the described scenario.",
      "",
      "## Workflow",
      "1. Use browser_navigate to go to the target URL.",
      "2. Use browser_snapshot to understand the page structure.",
      "3. Perform the scenario steps using browser_click, browser_fill_form, browser_select_option, browser_press_key, etc.",
      "4. After each action, use browser_snapshot to verify the result and understand the next state.",
      "5. When all scenario steps are done, output the recording events JSON.",
      "",
      "## Recording Events Output Format",
      "After completing all browser interactions, you MUST output a JSON block with the recording events.",
      "Wrap it in ```recording-events markers like this:",
      "",
      "```recording-events",
      '[{"type":"navigation","url":"https://example.com"},{"type":"click","selector":"#login-btn"},{"type":"input","selector":"#email","value":"user@test.com"}]',
      "```",
      "",
      "## Event Types and Fields",
      '- navigation: { "type": "navigation", "url": "...", "title": "..." }',
      '- click: { "type": "click", "selector": "..." }',
      '- dblclick: { "type": "dblclick", "selector": "..." }',
      '- input (fill): { "type": "input", "selector": "...", "value": "..." }',
      '- keydown: { "type": "keydown", "selector": "...", "key": "Enter" }',
      '- check: { "type": "check", "selector": "...", "checked": true }',
      '- select: { "type": "select", "selector": "...", "values": ["..."] }',
      '- scroll: { "type": "scroll", "x": 0, "y": 500 }',
      '- popup_opened: { "type": "popup_opened" }',
      "",
      "## Selector Rules",
      "- Prefer role selectors: role=button[name=\"Submit\"], role=link[name=\"Login\"]",
      "- Use placeholder selectors: [placeholder=\"Email\"]",
      "- Use data-testid: [data-testid=\"login-form\"]",
      "- Fallback to CSS: #id, .class, tag",
      "- Get selectors from the browser_snapshot accessibility tree — use the element's role and name.",
      "",
      "## Important",
      "- You MUST actually perform the actions in the browser using MCP tools, not just imagine them.",
      "- The recording events must reflect what you actually did in the browser.",
      "- Output ONLY the ```recording-events JSON block at the end. No other code blocks.",
      "- If a page requires login credentials or specific data, use placeholder values and add a comment in the first event."
    ].join("\n");

    scenarioHistory.push({ role: "user", prompt: prompt, url: url });

    const historyContext = scenarioHistory.map(function (entry, i) {
      if (entry.role === "user") {
        return "[User #" + (i + 1) + "] " + entry.prompt + (entry.url ? " (URL: " + entry.url + ")" : "");
      }
      return "[AI #" + (i + 1) + "] completed scenario";
    }).join("\n\n---\n\n");

    const fullPrompt = [
      systemInstruction,
      "",
      "=== Conversation History ===",
      historyContext,
      "",
      "=== Current Request ===",
      url ? "Target URL: " + url : "(no URL provided — ask the user or infer from the scenario)",
      "Scenario: " + prompt
    ].join("\n");

    const { spawn } = require("child_process");

    console.log("[AI-Scenario] === INPUT ===");
    console.log("[AI-Scenario] Prompt:", prompt);
    console.log("[AI-Scenario] URL:", url || "(none)");

    const child = spawn("npx", [
      "claude", "-p",
      "--max-turns", "30",
      "--model", "claude-sonnet-4-6",
      "--permission-mode", "bypassPermissions"
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();

    const chunks = [];
    const errChunks = [];

    child.stdout.on("data", function (data) {
      chunks.push(data);
    });

    child.stderr.on("data", function (data) {
      errChunks.push(data);
    });

    child.on("close", function (exitCode) {
      const stdout = Buffer.concat(chunks).toString().trim();
      const stderr = Buffer.concat(errChunks).toString().trim();

      console.log("[AI-Scenario] === OUTPUT ===");
      console.log("[AI-Scenario] Exit code:", exitCode);
      console.log("[AI-Scenario] Stdout length:", stdout.length);
      console.log("[AI-Scenario] Stdout preview:", stdout.slice(0, 500));
      if (stderr) console.log("[AI-Scenario] Stderr:", stderr.slice(0, 300));

      if (exitCode !== 0 || !stdout) {
        res.status(500).json({ ok: false, error: stderr || "claude exited with code " + exitCode });
        return;
      }

      // Parse recording events from output
      const eventsMatch = stdout.match(/```recording-events\n([\s\S]*?)```/);
      if (!eventsMatch) {
        // Fallback: try to find any JSON array in the output
        const jsonMatch = stdout.match(/\[[\s\S]*?\{[\s\S]*?"type"[\s\S]*?\}[\s\S]*?\]/);
        if (jsonMatch) {
          try {
            const events = JSON.parse(jsonMatch[0]);
            const recording = { events: events };
            const { generatePlaywrightCode } = require("../shared/playwright-generator");
            const code = generatePlaywrightCode(recording, { useDelays: false });
            scenarioHistory.push({ role: "ai", events: events });
            while (scenarioHistory.length > MAX_CONVERSATION_HISTORY) {
              scenarioHistory.shift();
            }
            res.json({ ok: true, code: code, events: events });
            return;
          } catch (_parseErr) {
            // ignore parse error, fall through
          }
        }

        // Last fallback: return raw output as code if it looks like Playwright code
        const codeMatch = stdout.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
        if (codeMatch) {
          res.json({ ok: true, code: codeMatch[1].trim(), events: [] });
          return;
        }

        res.status(500).json({ ok: false, error: "AI did not return recording events." });
        return;
      }

      try {
        const events = JSON.parse(eventsMatch[1].trim());
        const recording = { events: events };
        const { generatePlaywrightCode } = require("../shared/playwright-generator");
        const code = generatePlaywrightCode(recording, { useDelays: false });

        scenarioHistory.push({ role: "ai", events: events });
        while (scenarioHistory.length > MAX_CONVERSATION_HISTORY) {
          scenarioHistory.shift();
        }

        console.log("[AI-Scenario] Generated code from", events.length, "events");
        res.json({ ok: true, code: code, events: events });
      } catch (parseErr) {
        console.log("[AI-Scenario] JSON parse error:", parseErr.message);
        res.status(500).json({ ok: false, error: "Failed to parse recording events." });
      }
    });

    child.on("error", function (err) {
      console.log("[AI-Scenario] SPAWN ERROR:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    });
  });

  app.post("/api/ai-scenario-reset", function aiScenarioReset(_req, res) {
    scenarioHistory.length = 0;
    console.log("[AI-Scenario] Conversation history cleared");
    res.json({ ok: true });
  });

  const conversationHistory = [];

  app.post("/api/ai-prompt", function aiPrompt(req, res) {
    const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt.slice(0, MAX_PROMPT_LENGTH) : "";
    const code = req.body && typeof req.body.code === "string" ? req.body.code.slice(0, MAX_CODE_LENGTH) : "";
    if (!prompt) {
      res.status(400).json({ ok: false, error: "prompt is required" });
      return;
    }

    const systemInstruction = [
      "You are a Playwright test code assistant.",
      "The user has recorded browser interactions and generated Playwright test code.",
      "Modify or improve the code based on the user's request.",
      "You have access to Playwright MCP tools (browser_navigate, browser_snapshot, browser_click, etc). Use them to visit and analyze pages when the user mentions URLs or asks you to explore page structure.",
      "",
      "IMPORTANT CODE FORMAT RULES:",
      "- Use a single flat test() block. Do NOT use test.describe() or multiple test() blocks.",
      "- Use only these actions: page.goto(), page.locator().click(), page.locator().fill(), page.locator().press(), page.locator().check(), page.locator().uncheck(), page.locator().selectOption(), page.waitForTimeout(), page.evaluate() for scroll.",
      "- Do NOT use variables, template literals, const, if/else, expect(), assertions, .first(), .isVisible(), or any conditional logic.",
      "- Use plain string URLs directly in page.goto().",
      "- Use simple CSS selectors or role selectors in page.locator().",
      "- Add // comments to describe each step.",
      "",
      "Return ONLY the complete modified TypeScript code in a ```typescript code block, no explanations."
    ].join("\n");

    conversationHistory.push({ role: "user", prompt: prompt, code: code });

    const historyContext = conversationHistory.map(function (entry, i) {
      if (entry.role === "user") {
        return "[User #" + (i + 1) + "] " + entry.prompt + (entry.code ? "\nCode:\n" + entry.code : "");
      }
      return "[AI #" + (i + 1) + "]\n" + entry.response;
    }).join("\n\n---\n\n");

    const fullPrompt = [
      systemInstruction,
      "",
      "=== Conversation History ===",
      historyContext,
      "",
      "=== Current Request ===",
      "Current code:",
      code || "(empty)",
      "",
      "User request: " + prompt
    ].join("\n");

    const { spawn } = require("child_process");

    console.log("[AI] === INPUT ===");
    console.log("[AI] Prompt:", prompt);
    console.log("[AI] Code length:", (code || "").length, "chars");
    console.log("[AI] Full prompt length:", fullPrompt.length, "chars");

    const child = spawn("npx", [
      "claude", "-p",
      "--max-turns", "20",
      "--model", "claude-sonnet-4-6",
      "--permission-mode", "bypassPermissions"
    ], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();

    const chunks = [];
    const errChunks = [];

    child.stdout.on("data", function (data) {
      chunks.push(data);
      console.log("[AI] CHUNK:", data.toString().slice(0, 200));
    });

    child.stderr.on("data", function (data) {
      errChunks.push(data);
    });

    child.on("close", function (exitCode) {
      const stdout = Buffer.concat(chunks).toString().trim();
      const stderr = Buffer.concat(errChunks).toString().trim();

      console.log("[AI] === OUTPUT ===");
      console.log("[AI] Exit code:", exitCode);
      console.log("[AI] Stdout length:", stdout.length);
      console.log("[AI] Stdout preview:", stdout.slice(0, 500));
      if (stderr) console.log("[AI] Stderr:", stderr.slice(0, 300));

      if (exitCode !== 0 || !stdout) {
        res.status(500).json({ ok: false, error: stderr || "claude exited with code " + exitCode });
        return;
      }

      const codeMatch = stdout.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
      const resultCode = codeMatch ? codeMatch[1].trim() : stdout.trim();

      conversationHistory.push({ role: "ai", response: resultCode });
      while (conversationHistory.length > MAX_CONVERSATION_HISTORY) {
        conversationHistory.shift();
      }
      console.log("[AI] History:", conversationHistory.length, "entries");

      res.json({ ok: true, code: resultCode });
    });

    child.on("error", function (err) {
      console.log("[AI] SPAWN ERROR:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    });
  });

  app.post("/api/ai-reset", function aiReset(_req, res) {
    conversationHistory.length = 0;
    console.log("[AI] Conversation history cleared");
    res.json({ ok: true });
  });

  app.post("/api/session/reset", async function resetSession(req, res) {
    try {
      const closed = await closeSharedSession(req.body || {});
      res.json({ ok: true, closed });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/export", function exportCode(req, res) {
    try {
      const recording = req.body && req.body.recording ? req.body.recording : null;
      if (!recording || !Array.isArray(recording.events)) {
        res.status(400).json({ ok: false, error: "Invalid recording payload" });
        return;
      }

      const recordingsDir = path.join(process.cwd(), "recordings");
      const rawOutput = req.body.outputPath || path.join(recordingsDir, "session.js");
      const resolvedOutput = safeResolvePath(rawOutput, recordingsDir);
      if (!resolvedOutput) {
        res.status(400).json({ ok: false, error: "Output path must be inside recordings/" });
        return;
      }

      const absolutePath = writePlaywrightFile(recording, resolvedOutput, req.body.options || {});
      res.json({ ok: true, outputPath: absolutePath });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  return app;
}

async function runCli() {
  const command = process.argv[2] || "serve";

  if (command === "serve") {
    const app = createServer();
    app.listen(PORT, function onListen() {
      console.log("Server listening on http://localhost:" + PORT);
    });
    return;
  }

  if (command === "health") {
    process.stdout.write("ok\n");
    return;
  }

  if (command === "replay") {
    const sourcePath = process.argv[3];
    if (!sourcePath) {
      console.error("Usage: node server/index.js replay <recording.json>");
      process.exit(1);
    }

    const { recording, absolutePath } = loadRecordingFile(sourcePath);
    const result = await runRecording(recording, { headless: false, keepOpen: false, trace: true });
    console.log("Replayed:", absolutePath);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "export") {
    const sourcePath = process.argv[3];
    const outputPath = process.argv[4] || path.join(process.cwd(), "recordings", "session.js");

    if (!sourcePath) {
      console.error("Usage: node server/index.js export <recording.json> [output.js]");
      process.exit(1);
    }

    const { recording } = loadRecordingFile(sourcePath);
    const savedPath = writePlaywrightFile(recording, outputPath, { headless: false });
    console.log("Exported:", savedPath);
    return;
  }

  if (command === "show-trace") {
    const tracePath = process.argv[3];
    const targetPath = tracePath || getLastTracePath();
    if (!targetPath) {
      console.error("Usage: node server/index.js show-trace <trace.zip>");
      process.exit(1);
    }

    const openedPath = openTraceViewer(targetPath);
    console.log("Opened trace viewer:", openedPath);
    return;
  }

  if (command === "show-report") {
    const reportPath = process.argv[3] || path.join(process.cwd(), "recordings", "reports", "latest-report.html");
    const openedPath = openFileInBrowser(reportPath);
    console.log("Opened report:", openedPath);
    return;
  }

  console.error("Unknown command:", command);
  process.exit(1);
}

if (require.main === module) {
  runCli().catch(function onError(error) {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createServer
};
