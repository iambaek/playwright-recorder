import { crx } from 'playwright-crx';
import { normalizeRecordingToSteps, sanitizeEvents } from '../../shared/playwright-generator.js';
import { executeStep as sharedExecuteStep, describeStep } from '../../shared/stepExecutor.js';

const DEFAULT_ACTION_TIMEOUT_MS = 10000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15000;
const DEFAULT_MAX_DELAY_MS = 5000;

let activeCrxApp = null;

async function getCrxApp() {
  if (activeCrxApp) {
    try {
      await activeCrxApp.close().catch(() => {});
    } catch (_e) {}
    activeCrxApp = null;
  }
  activeCrxApp = await crx.start();
  return activeCrxApp;
}

async function releaseCrxApp(page) {
  if (!activeCrxApp) return;
  try {
    await activeCrxApp.detach(page).catch(() => {});
    await activeCrxApp.close().catch(() => {});
  } catch (_e) {}
  activeCrxApp = null;
}

function extractTestBody(codeText) {
  const lines = codeText.split('\n');
  const bodyLines = [];
  let insideTest = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!insideTest) {
      if (/^\s*(?:test|it)\s*\(/.test(line) || /async\s*\(\s*\{/.test(line)) {
        insideTest = true;
        braceDepth = 0;
        for (const ch of line) {
          if (ch === '{') braceDepth++;
          if (ch === '}') braceDepth--;
        }
        continue;
      }
      if (/^\s*(?:import|const\s*\{.*\}\s*=\s*require)/.test(line)) {
        continue;
      }
      if (line.trim() === '') continue;
      bodyLines.push(line);
      continue;
    }

    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    if (braceDepth <= 0) {
      insideTest = false;
      continue;
    }

    bodyLines.push(line);
  }

  return bodyLines.map(l => l.replace(/^  /, '')).join('\n').trim();
}

function parseCodeToSteps(codeText) {
  const body = extractTestBody(codeText);
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const steps = [];

  let pendingPopup = false;
  let popupInitialized = false;

  for (const line of lines) {
    if (line.startsWith('//')) continue;

    let m;

    // Detect popup_opened (both old and new patterns)
    // Don't push yet — defer until the triggering click is parsed
    if (/waitForEvent\(["'`]popup["'`]\)/.test(line) || /context\(\)\.waitForEvent\(["'`]page["'`]\)/.test(line)) {
      pendingPopup = true;
      continue;
    }
    if (/popupPage\.waitForLoadState/.test(line)) { continue; }
    if (/popupPromise/.test(line) && !/waitForEvent/.test(line)) { continue; }
    if (/Promise\.all/.test(line) || /^\s*\]\s*\)\s*;?\s*$/.test(line)) { continue; }
    if (/^\s*\[popupPage\]/.test(line) || /const\s+popupPage\s*=/.test(line)) { continue; }

    // Detect isPopup from popupPage prefix
    const isPopup = /popupPage\./.test(line);

    // Auto-insert popup_opened if popupPage is used without explicit popup setup
    if (isPopup && !popupInitialized && !pendingPopup) {
      // Find the last click/dblclick step and insert popup_opened after it
      let inserted = false;
      for (let si = steps.length - 1; si >= 0; si--) {
        if (steps[si].type === 'click' || steps[si].type === 'dblclick') {
          steps.splice(si + 1, 0, { type: 'popup_opened' });
          inserted = true;
          break;
        }
      }
      if (!inserted) { steps.push({ type: 'popup_opened' }); }
      popupInitialized = true;
    }

    m = line.match(/(?:popup)?[Pp]age\.goto\(["'`](.+?)["'`]/);
    if (m) { steps.push({ type: 'goto', url: m[1], isPopup }); continue; }

    m = line.match(/(?:popup)?[Pp]age\.waitForTimeout\((\d+)\)/);
    if (m) { steps.push({ type: 'wait', durationMs: Number(m[1]), isPopup }); continue; }

    m = line.match(/(?:popup)?[Pp]age\.evaluate\(.+?scrollTo.+?x:\s*(\d+).+?y:\s*(\d+)/s);
    if (m) { steps.push({ type: 'scroll', x: Number(m[1]), y: Number(m[2]), isPopup }); continue; }

    m = line.match(/\.locator\(["'`](.+?)["'`]\)\.click\(/);
    if (m) {
      const frames = parseFrameLocators(line);
      steps.push({ type: 'click', selector: m[1], frameSelectors: frames, isPopup });
      if (pendingPopup) { steps.push({ type: 'popup_opened' }); pendingPopup = false; popupInitialized = true; }
      continue;
    }

    m = line.match(/\.locator\(["'`](.+?)["'`]\)\.dblclick\(/);
    if (m) {
      const frames = parseFrameLocators(line);
      steps.push({ type: 'dblclick', selector: m[1], frameSelectors: frames, isPopup });
      if (pendingPopup) { steps.push({ type: 'popup_opened' }); pendingPopup = false; popupInitialized = true; }
      continue;
    }

    m = line.match(/\.locator\(["'`](.+?)["'`]\)\.fill\(["'`](.*?)["'`]/);
    if (m) {
      const frames = parseFrameLocators(line);
      steps.push({ type: 'fill', selector: m[1], value: m[2], frameSelectors: frames, isPopup });
      continue;
    }

    m = line.match(/\.locator\(["'`](.+?)["'`]\)\.press\(["'`](.+?)["'`]/);
    if (m) {
      const frames = parseFrameLocators(line);
      steps.push({ type: 'press', selector: m[1], key: m[2], frameSelectors: frames, isPopup });
      continue;
    }

    m = line.match(/\.locator\(["'`](.+?)["'`]\)\.check\(/);
    if (m) {
      const frames = parseFrameLocators(line);
      steps.push({ type: 'check', selector: m[1], frameSelectors: frames, isPopup });
      continue;
    }

    m = line.match(/\.locator\(["'`](.+?)["'`]\)\.uncheck\(/);
    if (m) {
      const frames = parseFrameLocators(line);
      steps.push({ type: 'uncheck', selector: m[1], frameSelectors: frames, isPopup });
      continue;
    }

    m = line.match(/\.locator\(["'`](.+?)["'`]\)\.selectOption\((.+?)\)/);
    if (m) {
      const frames = parseFrameLocators(line);
      let values = [];
      try { values = JSON.parse(m[2]); } catch (_e) { values = [m[2].replace(/["'`]/g, '')]; }
      steps.push({ type: 'select', selector: m[1], values, frameSelectors: frames, isPopup });
      continue;
    }

    m = line.match(/\.getByRole\(["'`](.+?)["'`](?:,\s*\{[^}]*name:\s*["'`](.+?)["'`])?/);
    if (m) {
      const selector = m[2] ? 'role=' + m[1] + '[name="' + m[2] + '"]' : 'role=' + m[1];
      const action = parseAction(line);
      if (action) {
        steps.push({ ...action, selector, frameSelectors: [], isPopup });
        if (pendingPopup && (action.type === 'click' || action.type === 'dblclick')) { steps.push({ type: 'popup_opened' }); pendingPopup = false; popupInitialized = true; }
        continue;
      }
    }

    m = line.match(/\.getByText\(["'`](.+?)["'`]/);
    if (m) {
      const selector = 'text=' + m[1];
      const action = parseAction(line);
      if (action) {
        steps.push({ ...action, selector, frameSelectors: [], isPopup });
        if (pendingPopup && (action.type === 'click' || action.type === 'dblclick')) { steps.push({ type: 'popup_opened' }); pendingPopup = false; popupInitialized = true; }
        continue;
      }
    }

    m = line.match(/\.getByPlaceholder\(["'`](.+?)["'`]/);
    if (m) {
      const selector = '[placeholder="' + m[1] + '"]';
      const action = parseAction(line);
      if (action) {
        steps.push({ ...action, selector, frameSelectors: [], isPopup });
        if (pendingPopup && (action.type === 'click' || action.type === 'dblclick')) { steps.push({ type: 'popup_opened' }); pendingPopup = false; popupInitialized = true; }
        continue;
      }
    }

    m = line.match(/\.getByTestId\(["'`](.+?)["'`]/);
    if (m) {
      const selector = '[data-testid="' + m[1] + '"]';
      const action = parseAction(line);
      if (action) {
        steps.push({ ...action, selector, frameSelectors: [], isPopup });
        if (pendingPopup && (action.type === 'click' || action.type === 'dblclick')) { steps.push({ type: 'popup_opened' }); pendingPopup = false; popupInitialized = true; }
        continue;
      }
    }
  }

  return steps;
}

function parseFrameLocators(line) {
  const frames = [];
  const re = /\.frameLocator\(["'`](.+?)["'`]\)/g;
  let fm;
  while ((fm = re.exec(line)) !== null) {
    frames.push(fm[1]);
  }
  return frames;
}

function parseAction(line) {
  let m;
  m = line.match(/\.click\(/);
  if (m) return { type: 'click' };
  m = line.match(/\.dblclick\(/);
  if (m) return { type: 'dblclick' };
  m = line.match(/\.fill\(["'`](.*?)["'`]/);
  if (m) return { type: 'fill', value: m[1] };
  m = line.match(/\.press\(["'`](.+?)["'`]/);
  if (m) return { type: 'press', key: m[1] };
  m = line.match(/\.check\(/);
  if (m) return { type: 'check' };
  m = line.match(/\.uncheck\(/);
  if (m) return { type: 'uncheck' };
  return null;
}

async function executeStepWithPopup(page, step) {
  if (step.type === 'click' || step.type === 'dblclick') {
    const popupPromise = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
    await executeStep(page, step);
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      return popup;
    }
    return null;
  }

  await executeStep(page, step);
  return null;
}

const stepOptions = {
  actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
  navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS
};

async function executeStep(page, step) {
  return sharedExecuteStep(page, step, stepOptions);
}

const ALLOWED_STEP_TYPES = new Set([
  'goto', 'click', 'dblclick', 'fill', 'press', 'check', 'uncheck',
  'select', 'scroll', 'wait', 'popup_opened'
]);

export async function replayCode(codeText, options = {}, onProgress) {
  if (typeof codeText !== 'string') {
    throw new Error('Invalid replay code: expected a string');
  }
  const skipOnError = options.skipOnError === true;
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const rawSteps = parseCodeToSteps(codeText);
  const steps = rawSteps.filter(step => ALLOWED_STEP_TYPES.has(step.type));
  const crxApp = await getCrxApp();
  let page = await crxApp.newPage();
  let popupPage = null;

  const context = page.context();
  context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);

  let completedSteps = 0;
  let currentPageUrl = '';
  const errors = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === 'goto') { currentPageUrl = step.url || ''; }

    notify({ type: 'step', index: i, total: steps.length, step: describeStep(step, i), status: 'running' });

    try {
      if (step.type === 'popup_opened') {
        // popup_opened is handled by the preceding click — just skip
        completedSteps += 1;
        notify({ type: 'step', index: i, total: steps.length, step: describeStep(step, i), status: 'done' });
        continue;
      }

      const targetPage = (step.isPopup && popupPage) ? popupPage : page;

      // If the next step is popup_opened, this click triggers a popup via window.open
      const nextStep = steps[i + 1];
      if ((step.type === 'click' || step.type === 'dblclick') && nextStep && nextStep.type === 'popup_opened') {
        // Use chrome.tabs.onCreated to detect the new tab, then crxApp.attach for full control
        let newTabId = null;
        const tabCreatedListener = (tab) => { newTabId = tab.id; };
        chrome.tabs.onCreated.addListener(tabCreatedListener);

        await executeStep(targetPage, step);

        // Wait for the new tab to appear
        const waitStart = Date.now();
        while (!newTabId && (Date.now() - waitStart) < DEFAULT_NAVIGATION_TIMEOUT_MS) {
          await new Promise(r => setTimeout(r, 100));
        }
        chrome.tabs.onCreated.removeListener(tabCreatedListener);

        if (newTabId) {
          // Wait for the tab to finish loading before attaching
          await new Promise(resolve => {
            const onUpdated = (tabId, changeInfo) => {
              if (tabId === newTabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(onUpdated);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(onUpdated);
            // Also resolve after timeout to avoid hanging
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 5000);
          });

          popupPage = await crxApp.attach(newTabId);
          await popupPage.waitForLoadState('load').catch(() => {});
          currentPageUrl = popupPage.url();
        }

        completedSteps += 1;
        notify({ type: 'step', index: i, total: steps.length, step: describeStep(step, i), status: 'done' });
        continue;
      }



      // For popup goto: check if already at URL, otherwise navigate explicitly
      if (step.type === 'goto' && step.isPopup && popupPage) {
        const currentUrl = popupPage.url();
        const targetUrl = step.url || '';
        if (currentUrl === targetUrl || currentUrl.split('?')[0] === targetUrl.split('?')[0]) {
          // Already at this URL (popup navigated here on open)
          completedSteps += 1;
          notify({ type: 'step', index: i, total: steps.length, step: describeStep(step, i), status: 'done' });
          continue;
        }
        await popupPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
        currentPageUrl = popupPage.url();
        completedSteps += 1;
        notify({ type: 'step', index: i, total: steps.length, step: describeStep(step, i), status: 'done' });
        continue;
      }

      const popup = await executeStepWithPopup(targetPage, step);
      if (popup) {
        if (step.isPopup) { popupPage = popup; } else { page = popup; }
        currentPageUrl = (step.isPopup ? popupPage : page).url();
      }
      completedSteps += 1;
      notify({ type: 'step', index: i, total: steps.length, step: describeStep(step, i), status: 'done' });
    } catch (error) {
      const errInfo = {
        stepIndex: i,
        stepDescription: describeStep(step, i),
        pageUrl: currentPageUrl || page.url(),
        errorMessage: error.message
      };
      errors.push(errInfo);

      if (skipOnError) {
        notify({ type: 'step', index: i, total: steps.length, step: describeStep(step, i), status: 'skipped', error: error.message });
        completedSteps += 1;
        continue;
      }

      await crxApp.detach(page).catch(() => {});
      if (popupPage) { await crxApp.detach(popupPage).catch(() => {}); }
      await crxApp.close().catch(() => {});
      return {
        ok: false,
        stepCount: steps.length,
        completedSteps,
        failedStep: errInfo,
        errors,
        errorMessage: errInfo.stepDescription + ' — ' + error.message + ' (page: ' + errInfo.pageUrl + ')',
        completedAt: new Date().toISOString()
      };
    }
  }

  await crxApp.detach(page).catch(() => {});
  if (popupPage) { await crxApp.detach(popupPage).catch(() => {}); }
  await crxApp.close().catch(() => {});

  return {
    ok: errors.length === 0,
    stepCount: steps.length,
    completedSteps,
    errors,
    errorMessage: errors.length > 0
      ? errors.length + ' step(s) skipped: ' + errors.map(e => e.stepDescription).join(', ')
      : '',
    completedAt: new Date().toISOString()
  };
}

export async function replayRecording(recording, options = {}) {
  const useDelays = options.useDelays === true;
  const actionTimeoutMs = Math.max(1000, Number(options.actionTimeoutMs) || DEFAULT_ACTION_TIMEOUT_MS);
  const navigationTimeoutMs = Math.max(1000, Number(options.navigationTimeoutMs) || DEFAULT_NAVIGATION_TIMEOUT_MS);
  const maxDelayMs = Math.max(0, Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS);

  const events = sanitizeEvents(recording.events);
  const steps = normalizeRecordingToSteps(recording, { includeDelays: useDelays });

  const crxApp = await getCrxApp();
  const page = await crxApp.newPage();

  const context = page.context();
  context.setDefaultTimeout(actionTimeoutMs);
  context.setDefaultNavigationTimeout(navigationTimeoutMs);

  let completedSteps = 0;

  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];

      if (step.type === 'wait') {
        await page.waitForTimeout(Math.min(step.durationMs || 0, maxDelayMs));
        completedSteps += 1;
        continue;
      }

      if (step.type === 'goto') {
        if (step.url && step.url.startsWith('chrome://')) {
          completedSteps += 1;
          continue;
        }
        await page.goto(step.url, {
          waitUntil: 'domcontentloaded',
          timeout: navigationTimeoutMs
        });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'scroll') {
        await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: step.x || 0, y: step.y || 0 });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'unsupported' || step.type === 'upload') {
        completedSteps += 1;
        continue;
      }

      let scope = page;
      if (Array.isArray(step.frameSelectors) && step.frameSelectors.length) {
        for (const frameSelector of step.frameSelectors) {
          scope = scope.frameLocator(frameSelector);
        }
      }

      const locator = scope.locator(step.selector);

      if (step.type === 'click') {
        await locator.click({ timeout: actionTimeoutMs });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'dblclick') {
        await locator.dblclick({ timeout: actionTimeoutMs });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'fill') {
        await locator.fill(step.value || '', { timeout: actionTimeoutMs });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'press') {
        await locator.press(step.key || 'Enter', { timeout: actionTimeoutMs });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'check') {
        await locator.check({ timeout: actionTimeoutMs });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'uncheck') {
        await locator.uncheck({ timeout: actionTimeoutMs });
        completedSteps += 1;
        continue;
      }

      if (step.type === 'select') {
        await locator.selectOption(step.values || [], { timeout: actionTimeoutMs });
        completedSteps += 1;
        continue;
      }
    }
  } catch (error) {
    await releaseCrxApp(page);

    const failedStep = steps[completedSteps] || null;
    const target = failedStep ? failedStep.selector || failedStep.url || failedStep.type : 'unknown';

    return {
      ok: false,
      eventCount: events.length,
      stepCount: steps.length,
      completedSteps,
      failedStepIndex: completedSteps,
      failedStepTarget: target,
      failedStepType: failedStep ? failedStep.type : 'unknown',
      errorMessage: error.message,
      completedAt: new Date().toISOString(),
      useDelays
    };
  }

  await crxApp.detach(page).catch(() => {});
  await crxApp.close().catch(() => {});

  return {
    ok: true,
    eventCount: events.length,
    stepCount: steps.length,
    completedSteps,
    completedAt: new Date().toISOString(),
    useDelays
  };
}
