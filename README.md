# Playwright Recoder

Chrome Extension으로 웹 서핑 동작을 기록하고, 그 결과를 Playwright 스크립트와 JSON 세션으로 저장한 뒤 Node.js에서 재생하는 예제 프로젝트입니다.

## 구성

- `extension/`: Chrome Extension (Manifest V3)
- `extension/options.html`: 확장 옵션 페이지
- `shared/`: 확장과 서버가 같이 쓰는 Playwright 코드 생성기
- `server/`: 로컬 API 서버 + CLI 재생기

## 설치

```bash
npm install
```

## 실행

1. 로컬 서버 실행

```bash
npm start
```

2. Chrome에서 `chrome://extensions` 열기
3. `개발자 모드` 활성화
4. `압축해제된 확장 프로그램을 로드합니다` 선택
5. 이 저장소의 `extension` 폴더 선택
6. 필요하면 확장 상세 화면의 `확장 프로그램 옵션`에서 기본 설정 조정

## 사용 방법

1. 확장 팝업에서 `Start Recording`
2. 웹 페이지에서 클릭, 입력, Enter 키, URL 이동 수행
3. 팝업에서 `Stop Recording`
4. 아래 중 하나 수행
   - `Download JSON`: 원본 세션 저장
   - `Download Playwright`: 실행 가능한 Playwright 스크립트 저장
   - `Replay Via Node`: 로컬 Node 서버로 전송 후 즉시 실행 + trace zip 저장
   - `Replay With Delay`: 녹화 당시 이벤트 간격(`delay_ms`)을 반영할지 선택
   - `Show Trace`: 마지막 실행의 `playwright show-trace` 열기
   - `Show Report`: 마지막 실행 기준 HTML 리포트 열기
   - `Reuse Browser Session`: 선택한 프로필의 브라우저 세션을 재사용해 로그인/쿠키 상태 유지
   - `Profile`: 프로필별로 쿠키와 세션을 분리해 관리
   - `Create Profile`: 새 프로필 생성
   - `Delete Profile`: 선택한 프로필 삭제
   - `Reset Session`: 선택한 프로필의 현재 재생 세션 초기화

## CLI 재생

저장한 JSON 파일을 직접 재생할 수도 있습니다.

```bash
node server/index.js replay ./recordings/session.json
```

마지막 trace를 직접 열 수도 있습니다.

```bash
node server/index.js show-trace ./recordings/traces/trace-xxxx.zip
```

## 현재 기록 범위

- 페이지 이동
- 클릭
- 더블클릭
- 텍스트 입력
- `Enter` 키 입력
- 체크박스 / 라디오
- 셀렉트 박스
- 스크롤
- 파일 선택 이름 기록
- 이벤트 간 딜레이 시간(`delay_ms`)

내부적으로는 기록 이벤트를 그대로 실행하지 않고, `goto / click / dblclick / fill / press / check / uncheck / select / scroll / wait` 형태의 중간 step 포맷으로 변환한 뒤 코드 생성과 재생에 사용합니다.

재사용 프로필은 macOS 기준으로 임시 캐시 경로인 `$(python -c "import tempfile; print(tempfile.gettempdir())")/playwright-recoder/profiles/chromium/<profile-name>` 아래에 저장됩니다.

확장하려면 `extension/content.js`에서 이벤트를 더 수집하고 `server/playwrightRunner.js`와 `shared/playwright-generator.js`에서 처리 규칙을 추가하면 됩니다.
