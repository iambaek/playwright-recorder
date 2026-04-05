(function initGenerator(root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
    return;
  }

  root.PlaywrightRecoderGenerator = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function createGenerator() {
  function escapeJs(value) {
    return JSON.stringify(value == null ? "" : String(value));
  }

  function sanitizeText(value) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .trim();
  }

  function ensureArray(events) {
    return Array.isArray(events) ? events : [];
  }

  function sanitizeEvents(events) {
    return ensureArray(events).filter(function keep(event) {
      return event && typeof event.type === "string";
    }).map(function normalizeEvent(event) {
      var next = Object.assign({}, event);
      if (typeof next.url === "string") {
        next.url = sanitizeText(next.url);
      }
      if (typeof next.selector === "string") {
        next.selector = sanitizeText(next.selector);
      }
      if (typeof next.value === "string") {
        next.value = sanitizeText(next.value);
      }
      if (typeof next.key === "string") {
        next.key = sanitizeText(next.key);
      }
      if (typeof next.text === "string") {
        next.text = sanitizeText(next.text);
      }
      if (Array.isArray(next.values)) {
        next.values = next.values.map(sanitizeText);
      }
      if (Array.isArray(next.fileNames)) {
        next.fileNames = next.fileNames.map(sanitizeText);
      }
      if (Array.isArray(next.frameSelectors)) {
        next.frameSelectors = next.frameSelectors.map(sanitizeText).filter(Boolean);
      }
      return next;
    });
  }

  function pushDelayStep(steps, event, options) {
    if (!options.includeDelays) {
      return;
    }

    if (typeof event.delayMs === "number" && event.delayMs > 0) {
      steps.push({
        type: "wait",
        durationMs: event.delayMs,
        isPopup: Boolean(event.isPopup)
      });
    }
  }

  function normalizeRecordingToSteps(recording, options) {
    var settings = options || {};
    var events = sanitizeEvents(recording && recording.events);
    var steps = [];

    events.forEach(function normalize(event, index) {
      var prevEvent = index > 0 ? events[index - 1] : null;

      // Skip navigation that was triggered by a click (keep the click, drop the goto)
      if (event.type === "navigation" && prevEvent && (prevEvent.type === "click" || prevEvent.type === "dblclick")) {
        return;
      }

      pushDelayStep(steps, event, settings);

      if (event.type === "popup_opened") {
        steps.push({ type: "popup_opened" });
        return;
      }

      if (event.type === "navigation") {
        steps.push({ type: "goto", url: event.url || "", title: event.title || "", isPopup: Boolean(event.isPopup) });
        return;
      }

      if (event.type === "click") {
        steps.push({ type: "click", selector: event.selector || "body", text: event.text || "", frameSelectors: event.frameSelectors || [], isPopup: Boolean(event.isPopup) });
        return;
      }

      if (event.type === "dblclick") {
        steps.push({ type: "dblclick", selector: event.selector || "body", text: event.text || "", frameSelectors: event.frameSelectors || [], isPopup: Boolean(event.isPopup) });
        return;
      }

      if (event.type === "input") {
        steps.push({
          type: "fill",
          selector: event.selector || "body",
          value: event.value || "",
          frameSelectors: event.frameSelectors || [],
          isPopup: Boolean(event.isPopup)
        });
        return;
      }

      if (event.type === "keydown") {
        steps.push({
          type: "press",
          selector: event.selector || "body",
          key: event.key || "Enter",
          frameSelectors: event.frameSelectors || [],
          isPopup: Boolean(event.isPopup)
        });
        return;
      }

      if (event.type === "check") {
        steps.push({
          type: event.checked ? "check" : "uncheck",
          selector: event.selector || "body",
          frameSelectors: event.frameSelectors || [],
          isPopup: Boolean(event.isPopup)
        });
        return;
      }

      if (event.type === "select") {
        steps.push({
          type: "select",
          selector: event.selector || "body",
          values: Array.isArray(event.values) ? event.values : [event.value || ""],
          frameSelectors: event.frameSelectors || [],
          isPopup: Boolean(event.isPopup)
        });
        return;
      }

      if (event.type === "scroll") {
        steps.push({
          type: "scroll",
          x: typeof event.x === "number" ? event.x : 0,
          y: typeof event.y === "number" ? event.y : 0,
          isPopup: Boolean(event.isPopup)
        });
        return;
      }

      if (event.type === "upload") {
        steps.push({
          type: "upload",
          selector: event.selector || "body",
          fileNames: Array.isArray(event.fileNames) ? event.fileNames : [],
          frameSelectors: event.frameSelectors || [],
          isPopup: Boolean(event.isPopup)
        });
        return;
      }

      steps.push({
        type: "unsupported",
        originalType: event.type
      });
    });

    // Post-process: move popup_opened right after its triggering click/dblclick
    // Recording order is: click → delay → popup_opened, but code generation
    // needs: click → popup_opened so they can be combined into Promise.all
    for (var pi = steps.length - 1; pi >= 0; pi--) {
      if (steps[pi].type !== "popup_opened") { continue; }
      for (var pj = pi - 1; pj >= 0; pj--) {
        if (steps[pj].type === "click" || steps[pj].type === "dblclick") {
          var popupStep = steps.splice(pi, 1)[0];
          steps.splice(pj + 1, 0, popupStep);
          break;
        }
      }
    }

    return steps;
  }

  function buildLocatorExpr(scope, selector) {
    var roleMatch = selector.match(/^role=(\w+)\[name="(.+)"\]$/);
    if (roleMatch) {
      return scope + ".getByRole(" + escapeJs(roleMatch[1]) + ", { name: " + escapeJs(roleMatch[2]) + " })";
    }

    var placeholderMatch = selector.match(/^\[placeholder="(.+)"\]$/);
    if (placeholderMatch) {
      return scope + ".getByPlaceholder(" + escapeJs(placeholderMatch[1]) + ")";
    }

    var testIdMatch = selector.match(/^\[data-testid="(.+)"\]$/);
    if (testIdMatch) {
      return scope + ".getByTestId(" + escapeJs(testIdMatch[1]) + ")";
    }

    return scope + ".locator(" + escapeJs(selector) + ")";
  }

  function buildStep(step) {
    var pageVar = step.isPopup ? "popupPage" : "page";
    var scope = pageVar;
    if (Array.isArray(step.frameSelectors) && step.frameSelectors.length) {
      scope = step.frameSelectors.reduce(function chain(target, selector) {
        return target + ".frameLocator(" + escapeJs(selector) + ")";
      }, pageVar);
    }

    var loc = step.selector ? buildLocatorExpr(scope, step.selector) : null;

    switch (step.type) {
      case "popup_opened":
        return null;
      case "wait":
        return "  await " + pageVar + ".waitForTimeout(" + String(step.durationMs || 0) + ");";
      case "goto":
        var titleComment = step.title ? "  // Page: " + step.title + "\n" : "";
        return titleComment + "  await " + pageVar + ".goto(" + escapeJs(step.url) + ");";
      case "click":
        return "  await " + loc + ".click();";
      case "dblclick":
        return "  await " + loc + ".dblclick();";
      case "fill":
        return "  await " + loc + ".fill(" + escapeJs(step.value) + ");";
      case "press":
        return "  await " + loc + ".press(" + escapeJs(step.key) + ");";
      case "check":
        return "  await " + loc + ".check();";
      case "uncheck":
        return "  await " + loc + ".uncheck();";
      case "select":
        return "  await " + loc + ".selectOption(" + JSON.stringify(step.values || []) + ");";
      case "scroll":
        return "  await " + pageVar + ".evaluate(({ x, y }) => window.scrollTo(x, y), " + JSON.stringify({ x: step.x || 0, y: step.y || 0 }) + ");";
      case "upload":
        return "  // Upload step recorded for " + escapeJs(step.selector) + " but local file paths are unavailable in extension recording.";
      default:
        return "  // Unsupported step: " + escapeJs(step.originalType || step.type);
    }
  }

  function buildMetadataComments(recording) {
    var lines = [];
    var consoleLogs = ensureArray(recording && recording.consoleLogs);

    var errors = consoleLogs.filter(function (l) {
      return l.level === "error" || l.level === "warning";
    });

    if (errors.length > 0) {
      lines.push("/*");
      lines.push(" * Console " + (errors[0].level === "error" ? "errors" : "warnings") + " during recording:");
      for (var j = 0; j < Math.min(errors.length, 10); j++) {
        lines.push(" *   [" + errors[j].level + "] " + errors[j].text.slice(0, 120));
      }
      if (errors.length > 10) {
        lines.push(" *   ... and " + (errors.length - 10) + " more");
      }
      lines.push(" */");
    }

    return lines.join("\n");
  }

  function generatePlaywrightCode(recording, options) {
    var settings = options || {};
    var steps = normalizeRecordingToSteps(recording, {
      includeDelays: settings.useDelays !== false
    });
    var testName = settings.testName || "test";
    var renderedLines = [];
    for (var si = 0; si < steps.length; si++) {
      var nextStep = steps[si + 1];
      // click/dblclick followed by popup_opened → combine into popup pattern
      if ((steps[si].type === "click" || steps[si].type === "dblclick") && nextStep && nextStep.type === "popup_opened") {
        var clickLine = buildStep(steps[si]).trim().replace(/^await\s+/, "").replace(/;$/, "");
        renderedLines.push("  const [popupPage] = await Promise.all([");
        renderedLines.push("    page.waitForEvent('popup'),");
        renderedLines.push("    " + clickLine + ",");
        renderedLines.push("  ]);");
        renderedLines.push("  await popupPage.waitForLoadState();");
        si++; // skip popup_opened
        continue;
      }
      var line = buildStep(steps[si]);
      if (line !== null) {
        renderedLines.push(line);
      }
    }
    var renderedSteps = renderedLines.join("\n");
    var metadata = buildMetadataComments(recording);

    var parts = [
      "import { test, expect } from '@playwright/test';"
    ];

    if (metadata) {
      parts.push("");
      parts.push(metadata);
    }

    parts.push("");
    parts.push("test(" + escapeJs(testName) + ", async ({ page }) => {");
    parts.push(renderedSteps);
    parts.push("});");
    parts.push("");

    return parts.join("\n");
  }

  return {
    generatePlaywrightCode: generatePlaywrightCode,
    normalizeRecordingToSteps: normalizeRecordingToSteps,
    sanitizeEvents: sanitizeEvents
  };
});
