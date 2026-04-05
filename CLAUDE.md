# Playwright Recoder - Project Guide

## Build & Test
- Build: `npm run build`
- Test: `node --test tests/playwright-generator.test.js`
- Start server: `npm start` (port 3100)

## Architecture
- `extension/src/background.js` → esbuild → `extension/dist/background.js` (service worker)
- `extension/src/crxPlayer.js` — playwright-crx 기반 브라우저 내 replay 엔진
- `extension/popup.js` — side panel UI (자체 구문 하이라이팅, 외부 라이브러리 사용 금지)
- `extension/content.js` — 페이지 이벤트 캡처 (click, input, navigation 등)
- `shared/playwright-generator.js` — 녹화 이벤트 → Playwright 코드 변환
- `shared/stepExecutor.js` — 공유 step 실행 로직

## 중요 기술 결정

### popup 창 (window.open) 처리 — playwright-crx
- `page.waitForEvent('popup')`은 playwright-crx에서 debugger가 제대로 연결되지 않아 popup 제어 불가
- **반드시 `chrome.tabs.onCreated` + `crxApp.attach(tabId)` 조합 사용**
  - `chrome.tabs.onCreated`로 새 탭 ID 감지
  - `chrome.tabs.onUpdated`로 로딩 완료 대기
  - `crxApp.attach(tabId)`로 debugger 연결 → 완전한 page 제어 가능
- 코드 생성은 `Promise.all([page.waitForEvent('popup'), click()])` 패턴 사용 (Playwright 표준 호환)
- 파서는 `waitForEvent('popup')` 패턴과 레거시 `popupPage.` 직접 사용 모두 인식

### popup 코드 생성 순서
- 녹화 이벤트 순서: `click → delay → popup_opened`
- `normalizeRecordingToSteps` 후처리에서 `popup_opened`를 트리거 click 바로 뒤로 이동
- click 이후 발생하는 navigation은 스킵 (click이 이미 네비게이션 트리거)

### Chrome 확장 CSP 제약
- CDN 외부 스크립트(CodeMirror, highlight.js 등) 로드 불가
- popup.html/popup.js에서 자체 구현 구문 하이라이팅 사용
