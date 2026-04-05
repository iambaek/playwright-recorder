(function initStepExecutor(root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
    return;
  }
  root.PlaywrightStepExecutor = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function createStepExecutor() {

  async function executeStep(page, step, options) {
    var actionTimeoutMs = (options && options.actionTimeoutMs) || 10000;
    var navigationTimeoutMs = (options && options.navigationTimeoutMs) || 15000;
    var maxDelayMs = (options && options.maxDelayMs) || 5000;

    if (step.type === "wait") {
      await page.waitForTimeout(Math.min(step.durationMs || 0, maxDelayMs));
      return;
    }

    if (step.type === "goto") {
      if (step.url && step.url.startsWith("chrome://")) return;
      await page.goto(step.url, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs
      });
      return;
    }

    if (step.type === "scroll") {
      await page.evaluate(function scrollTo(coords) {
        window.scrollTo(coords.x, coords.y);
      }, { x: step.x || 0, y: step.y || 0 });
      return;
    }

    if (step.type === "unsupported" || step.type === "upload") {
      return;
    }

    var scope = page;
    if (Array.isArray(step.frameSelectors) && step.frameSelectors.length) {
      for (var i = 0; i < step.frameSelectors.length; i++) {
        scope = scope.frameLocator(step.frameSelectors[i]);
      }
    }

    var locator = scope.locator(step.selector);

    if (step.type === "click") {
      await locator.click({ timeout: actionTimeoutMs });
    } else if (step.type === "dblclick") {
      await locator.dblclick({ timeout: actionTimeoutMs });
    } else if (step.type === "fill") {
      await locator.fill(step.value || "", { timeout: actionTimeoutMs });
    } else if (step.type === "press") {
      await locator.press(step.key || "Enter", { timeout: actionTimeoutMs });
    } else if (step.type === "check") {
      await locator.check({ timeout: actionTimeoutMs });
    } else if (step.type === "uncheck") {
      await locator.uncheck({ timeout: actionTimeoutMs });
    } else if (step.type === "select") {
      await locator.selectOption(step.values || [], { timeout: actionTimeoutMs });
    }
  }

  function describeStep(step, index) {
    var num = "Step " + (index + 1);
    if (step.type === "goto") return num + " goto: " + (step.url || "");
    if (step.type === "click") return num + " click: " + (step.selector || "");
    if (step.type === "fill") return num + " fill: " + (step.selector || "") + ' = "' + (step.value || "") + '"';
    if (step.type === "press") return num + " press: " + (step.key || "");
    return num + " " + step.type + ": " + (step.selector || step.url || "");
  }

  return {
    executeStep: executeStep,
    describeStep: describeStep
  };
});
