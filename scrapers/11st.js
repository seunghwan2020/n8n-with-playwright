// ============================================
// [11st.js] - 11번가 셀러오피스 로그인 & 재고 크롤링
// v4: "인증정보 선택하기" 그리드 로딩/행 선택 안정화 + 재시도 + 스크린샷 디버깅
// ============================================

const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const fs = require('fs');
const XLSX = require('xlsx');

const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];
const NAVER_USER = process.env['EMAIL_USER'];
const NAVER_PW = process.env['EMAIL_PW'];

let globalBrowser = null;
let globalPage = null;
let globalOtpRequestTime = 0;

// ============================================
// 🔧 세션 초기화 함수
// - 비유: "방을 완전히 청소하고 새로 시작"
// - auth.json 삭제 + 브라우저 종료 + 전역 변수 초기화
// ============================================
async function clearSession(reason = 'unknown') {
  console.log(`[SESSION_CLEAR] 세션 초기화 시작 (사유: ${reason})`);

  // 1) auth.json 삭제
  try {
    if (fs.existsSync('auth.json')) {
      fs.unlinkSync('auth.json');
      console.log('[SESSION_CLEAR] ✅ auth.json 삭제 완료');
    } else {
      console.log('[SESSION_CLEAR] auth.json 파일 없음 (이미 깨끗)');
    }
  } catch (err) {
    console.error('[SESSION_CLEAR] ⚠️ auth.json 삭제 실패:', err.message);
  }

  // 2) 브라우저 종료
  try {
    if (globalBrowser) {
      await globalBrowser.close();
      console.log('[SESSION_CLEAR] ✅ 브라우저 종료 완료');
    }
  } catch (err) {
    console.error('[SESSION_CLEAR] ⚠️ 브라우저 종료 실패:', err.message);
  }

  // 3) 전역 변수 초기화
  globalBrowser = null;
  globalPage = null;
  globalOtpRequestTime = 0;
  console.log('[SESSION_CLEAR] ✅ 전역 변수 초기화 완료');
}

// ============================================
// 🔧 스크린샷 유틸리티 함수
// - n8n에서 base64로 받아서 Analyze Image 등으로 확인 가능
// ============================================
async function takeScreenshot(page, label = 'debug') {
  try {
    if (!page || page.isClosed()) {
      console.log(`[SCREENSHOT] 페이지가 없거나 닫혀있어서 스크린샷 불가: ${label}`);
      return null;
    }
    const buffer = await page.screenshot({ fullPage: true, timeout: 10000 });
    const base64 = buffer.toString('base64');
    console.log(`[SCREENSHOT] ${label} - 캡처 성공 (${Math.round(base64.length / 1024)}KB)`);
    return base64;
  } catch (err) {
    console.error(`[SCREENSHOT] ${label} - 캡처 실패:`, err.message);
    return null;
  }
}

// ============================================
// 🔧 11번가 "인증정보 선택하기" 화면 처리
// - 버튼 클릭 → 그리드(계정 목록) 로딩 대기 → 첫 행 선택 시도
// - 그리드가 계속 비면: 재클릭/리로드 재시도
// ============================================
async function ensureAuthAccountSelected(page) {
  console.log('[AUTH_SELECT] STEP A1: 인증정보 선택 화면 처리 시작');

  const btn = page.locator('button:has-text("인증정보 선택하기")').first();

  // 이 화면 자체가 없으면 바로 리턴
  const visible = await btn.isVisible().catch(() => false);
  if (!visible) {
    console.log('[AUTH_SELECT] STEP A1: 인증정보 선택 버튼 없음 → 처리 불필요');
    return { handled: false, selected: false };
  }

  console.log('[AUTH_SELECT] STEP A2: 인증정보 선택 버튼 감지');

  const gridRow = page.locator('table tbody tr');
  const maxTry = 4;

  for (let t = 1; t <= maxTry; t++) {
    console.log(`[AUTH_SELECT] STEP A3-${t}: 버튼 클릭 & 그리드 로딩 대기 (${t}/${maxTry})`);

    // 버튼 클릭 (그리드/레이어 열기 트리거)
    await btn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1200);

    // 그리드 로딩 대기
    const rowCount = await gridRow.count().catch(() => 0);
    console.log(`[AUTH_SELECT] STEP A3-${t}: rowCount=${rowCount}`);

    if (rowCount > 0) {
      // 첫 행 선택 시도: 라디오/체크박스 있으면 체크, 없으면 행 클릭
      const firstRow = gridRow.first();
      const radio = firstRow.locator('input[type="radio"], input[type="checkbox"]');

      const radioCount = await radio.count().catch(() => 0);
      console.log(`[AUTH_SELECT] STEP A4-${t}: 첫 행 내 선택 input 개수=${radioCount}`);

      if (radioCount > 0) {
        // check가 안 먹히는 DOM도 있어서 click fallback
        await radio.first().check({ force: true }).catch(async () => {
          await radio.first().click({ force: true }).catch(() => {});
        });
      } else {
        await firstRow.click({ force: true }).catch(() => {});
      }

      console.log('[AUTH_SELECT] STEP A5: ✅ 계정 선택 시도 완료');
      await page.waitForTimeout(800);
      return { handled: true, selected: true };
    }

    // 아직도 비면: 중간에 리로드 1회 섞기
    if (t === 2) {
      console.log('[AUTH_SELECT] STEP A6: 그리드가 비어있음 → 페이지 리로드 후 재시도');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(2500);
    } else {
      console.log('[AUTH_SELECT] STEP A6: 그리드가 비어있음 → 잠시 대기 후 재시도');
      await page.waitForTimeout(1500);
    }
  }

  console.log('[AUTH_SELECT] STEP A7: ⚠️ 그리드 로딩 실패(계속 빈 상태)');
  return { handled: true, selected: false };
}

// ============================================
// 메일에서 인증코드 가져오기 (네이버웍스/웍스모바일 IMAP)
// ============================================
async function getAuthCodeFromMail() {
  console.log('[MAIL] STEP M1: IMAP 접속 시도');
  const client = new ImapFlow({
    host: 'imap.worksmobile.com',
    port: 993,
    secure: true,
    auth: { user: NAVER_USER, pass: NAVER_PW },
    logger: false,
  });

  await client.connect();
  console.log('[MAIL] STEP M2: IMAP 연결 완료');

  let lock = await client.getMailboxLock('INBOX');
  let authCode = null;

  try {
    console.log('[MAIL] STEP M3: 안 읽은 메일(unseen) 검색');
    const searchList = await client.search({ unseen: true });
    console.log('[MAIL] STEP M3: unseen 개수=', searchList.length);

    if (searchList.length > 0) {
      const latestSeq = searchList[searchList.length - 1];
      console.log('[MAIL] STEP M4: 최신 unseen seq=', latestSeq);

      const message = await client.fetchOne(latestSeq, { source: true });

      if (message && message.source) {
        console.log('[MAIL] STEP M5: 메일 파싱 시작');
        const mail = await simpleParser(message.source);
        const mailDate = mail.date ? mail.date.getTime() : 0;

        console.log('[MAIL] STEP M5: 메일 날짜(ms)=', mailDate, '요청시간(ms)=', globalOtpRequestTime);

        // 인증번호 요청 시각보다 과거 메일이면 무시
        if (mailDate < globalOtpRequestTime) {
          console.log('[MAIL] STEP M6: 과거 메일로 판단 → 무시');
          return null;
        }

        await client.messageFlagsAdd(latestSeq, ['\\Seen']);
        console.log('[MAIL] STEP M7: 메일 읽음 처리 완료');

        const mailText = mail.text || mail.html || '';
        const match = String(mailText).match(/\d{6,8}/); // 6~8자리 숫자
        if (match) {
          authCode = match[0];
          console.log('[MAIL] STEP M8: ✅ 인증코드 추출 성공:', authCode);
        } else {
          console.log('[MAIL] STEP M8: 인증코드 패턴 미검출');
        }
      }
    }
  } catch (err) {
    console.error('[MAIL_ERROR] STEP M-ERR:', err.message);
    console.error('[MAIL_ERROR] STACK:', err.stack);
  } finally {
    lock.release();
    await client.logout();
    console.log('[MAIL] STEP M9: IMAP 종료');
  }

  return authCode;
}

// ============================================
// Playwright 브라우저/페이지 생성 helper
// ============================================
async function createBrowserAndPage({ storageStatePath = null } = {}) {
  console.log('[BROWSER] STEP B1: 브라우저 실행');

  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  console.log('[BROWSER] STEP B2: context 생성');

  const contextOptions = {
    viewport: { width: 1400, height: 1000 },
    locale: 'ko-KR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  };

  if (storageStatePath) {
    contextOptions.storageState = storageStatePath;
    console.log('[BROWSER] STEP B2-1: storageState 적용:', storageStatePath);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  page.on('dialog', async (dialog) => {
    console.log('[BROWSER] dialog 감지 → 자동 accept');
    await dialog.accept().catch(() => {});
  });

  return { browser, page };
}

// ============================================
// 메인 실행 함수
// ============================================
async function execute(action, req, res) {
  console.log('============================================');
  console.log('[EXECUTE] action=', action);
  console.log('[EXECUTE] time=', new Date().toISOString());
  console.log('============================================');

  try {
    // 기본 환경변수 체크
    if (!USER_ID || !USER_PW) {
      console.error('[STEP 0] 11th_USER / 11th_PW 환경변수 누락');
      return res.json({
        status: 'ERROR',
        message: '환경변수 누락: 11th_USER 또는 11th_PW가 없습니다.',
        needsLogin: true,
      });
    }

    if (!NAVER_USER || !NAVER_PW) {
      console.error('[STEP 0] EMAIL_USER / EMAIL_PW 환경변수 누락');
      return res.json({
        status: 'ERROR',
        message: '환경변수 누락: EMAIL_USER 또는 EMAIL_PW가 없습니다.',
        needsLogin: true,
      });
    }

    // ============================
    // 액션: reset (수동 세션 초기화)
    // n8n에서 { site: "11st", action: "reset" } 보내면 세션 강제 리셋
    // ============================
    if (action === 'reset') {
      console.log('[STEP 1] 수동 세션 초기화 요청');
      await clearSession('manual_reset');
      return res.json({
        status: 'SUCCESS',
        message: '세션 완전 초기화 완료. 다음 요청 시 새로 로그인됩니다.',
      });
    }

    // ============================
    // 액션: login
    // ============================
    if (action === 'login') {
      console.log('[STEP 1] Starting Login...');

      // 기존 브라우저만 정리 (auth.json은 유지하여 재사용 시도)
      if (globalBrowser) {
        console.log('[STEP 1-1] 기존 브라우저 종료');
        await globalBrowser.close().catch(() => {});
        globalBrowser = null;
        globalPage = null;
      }

      const hasStorage = fs.existsSync('auth.json');
      console.log('[STEP 1-2] auth.json 존재 여부:', hasStorage);

      // 1차: 저장된 세션으로 재사용 시도
      console.log('[STEP 1-3] 브라우저/페이지 생성 (세션 재사용 시도)');
      const first = await createBrowserAndPage({ storageStatePath: hasStorage ? 'auth.json' : null });
      globalBrowser = first.browser;
      globalPage = first.page;

      console.log('[STEP 2] 로그인 페이지 이동');
      await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await globalPage.waitForTimeout(4000);

      console.log('[STEP 2-1] 현재 URL:', globalPage.url());

      // ✅ 세션 재사용 성공(이미 셀러오피스로 리다이렉트 된 케이스)
      if (globalPage.url().includes('soffice.11st.co.kr')) {
        console.log('[STEP 2-2] ✅ 세션 재사용 성공! 이미 로그인됨');
        return res.json({ status: 'SUCCESS', message: '세션 재사용 성공' });
      }

      // 세션이 있었는데도 login 페이지면: 만료 가능성이 큼 → 완전 초기화 후 새로그인
      if (hasStorage) {
        console.log('[STEP 2-3] ⚠️ 저장된 세션이 있지만 로그인 페이지에 머묾 → 만료로 판단');
        await clearSession('expired_session');
      }

      // 2차: 깨끗한 새 세션으로 로그인
      console.log('[STEP 2-4] 새 브라우저/페이지 생성 (깨끗한 세션)');
      const fresh = await createBrowserAndPage({ storageStatePath: null });
      globalBrowser = fresh.browser;
      globalPage = fresh.page;

      console.log('[STEP 2-5] 로그인 페이지 재이동');
      await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await globalPage.waitForTimeout(3000);

      await takeScreenshot(globalPage, 'login-page-loaded');

      console.log('[STEP 3] ID/PW 입력');
      await globalPage.fill('#loginName', USER_ID);
      await globalPage.fill('#passWord', USER_PW);

      console.log('[STEP 3-1] 로그인 버튼 클릭');
      await globalPage.click('button.c-button--submit');
      await globalPage.waitForTimeout(4000);

      console.log('[STEP 3-2] 로그인 후 URL:', globalPage.url());

      // 로그인 실패 감지
      if (globalPage.url().includes('login.11st.co.kr')) {
        const errorMsg = await globalPage
          .locator('.error-message, .alert-message, .c-alert')
          .first()
          .textContent()
          .catch(() => null);

        if (errorMsg && errorMsg.trim()) {
          console.error('[STEP 3-3] ❌ 로그인 실패:', errorMsg.trim());
          const shot = await takeScreenshot(globalPage, 'login-failed');
          await clearSession('login_failed');
          return res.json({
            status: 'ERROR',
            message: `로그인 실패: ${errorMsg.trim()}`,
            needsLogin: true,
            screenshot: shot,
            screenshot_label: 'login-failed',
          });
        }
      }

      // 여기서부터: 2단계 인증 여부 처리
      console.log('[STEP 4] 2단계 인증/셀러오피스 진입 여부 확인');

      // 4-1) "인증정보 선택하기" 화면이 있으면: 그리드 로딩/행 선택까지 확실히 처리
      const authSel = await ensureAuthAccountSelected(globalPage);

      if (authSel.handled && !authSel.selected) {
        console.error('[STEP 4-1] ❌ 인증정보 선택 그리드가 비어있어 진행 불가');
        const shot = await takeScreenshot(globalPage, 'auth-grid-empty');
        await clearSession('auth_grid_empty');
        return res.json({
          status: 'ERROR',
          message:
            '2단계 인증 "인증정보 선택" 그리드가 비어있어 진행 불가(재시도 실패). 세션 초기화 후 다시 시도하세요.',
          needsLogin: true,
          screenshot: shot,
          screenshot_label: 'auth-grid-empty',
        });
      }

      // 4-2) 이미 셀러오피스로 진입된 경우
      if (globalPage.url().includes('soffice.11st.co.kr')) {
        console.log('[STEP 4-2] ✅ 이미 셀러오피스 진입됨 → 세션 저장');
        await globalPage.context().storageState({ path: 'auth.json' });
        return res.json({ status: 'SUCCESS', message: '로그인 성공(2FA 없이 진입)' });
      }

      // 4-3) 이메일 인증 라디오/버튼 처리
      const emailAuthLabel = globalPage.locator('label[for="auth_type_02"]').first();

      if (await emailAuthLabel.isVisible().catch(() => false)) {
        console.log('[STEP 5] 이메일 인증 UI 감지 → 인증번호 전송 진행');
        await emailAuthLabel.click({ force: true }).catch(() => {});
        globalOtpRequestTime = Date.now() - 60000;

        const sendBtn = globalPage.locator('button:has-text("인증번호 전송")').first();
        await sendBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await sendBtn.click({ force: true }).catch(() => {});

        console.log('[STEP 5-1] ✅ 인증번호 전송 클릭 완료');
        return res.json({ status: 'AUTH_REQUIRED', message: '이메일 인증번호 전송됨' });
      } else {
        // 늦게 뜨는 경우 1회 더 대기 후 재확인
        console.log('[STEP 5] 이메일 인증 UI 미검출 → 2초 대기 후 재확인');
        await globalPage.waitForTimeout(2000);

        if (await emailAuthLabel.isVisible().catch(() => false)) {
          console.log('[STEP 5-2] (재확인) 이메일 인증 UI 감지 → 인증번호 전송');
          await emailAuthLabel.click({ force: true }).catch(() => {});
          globalOtpRequestTime = Date.now() - 60000;

          const sendBtn = globalPage.locator('button:has-text("인증번호 전송")').first();
          await sendBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
          await sendBtn.click({ force: true }).catch(() => {});

          console.log('[STEP 5-3] ✅ 인증번호 전송 클릭 완료(재확인)');
          return res.json({ status: 'AUTH_REQUIRED', message: '이메일 인증번호 전송됨' });
        }
      }

      // 4-4) 여기까지 왔는데도 셀러오피스/인증 UI가 없으면: 상태가 애매 → 스샷 찍고 에러 반환
      console.error('[STEP 6] ⚠️ 로그인 후 예상 UI 미검출(셀러오피스/인증 선택/이메일 인증 모두 없음)');
      const shot = await takeScreenshot(globalPage, 'login-unknown-state');
      await clearSession('login_unknown_state');
      return res.json({
        status: 'ERROR',
        message: '로그인 후 상태가 예상과 다릅니다(2FA UI 미확인). 세션 초기화 후 다시 시도하세요.',
        needsLogin: true,
        screenshot: shot,
        screenshot_label: 'login-unknown-state',
      });
    }

    // ============================
    // 액션: verify_auto
    // ============================
    if (action === 'verify_auto') {
      console.log('[STEP 1] 이메일 인증코드 자동 확인 시작');

      if (!globalPage) {
        console.log('[STEP 1-1] ⚠️ 브라우저 세션 없음 → 세션 초기화');
        await clearSession('no_page_on_verify');
        return res.json({
          status: 'ERROR',
          message: '브라우저 세션 없음. login부터 다시 시작하세요.',
          needsLogin: true,
        });
      }

      console.log('[STEP 1-2] 현재 URL:', globalPage.url());

      const code = await getAuthCodeFromMail();
      if (!code) {
        console.log('[STEP 1-3] 아직 인증 메일 없음 → 대기');
        return res.json({ status: 'WAIT', message: '인증 메일 대기 중' });
      }

      console.log(`[STEP 2] 인증코드 입력: ${code}`);

      // 인증번호 입력칸이 늦게 뜨는 경우 대비
      const input = globalPage.locator('#auth_num_email').first();
      await input.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await input.fill(code).catch(() => {});

      // 버튼 클릭 (기존 onclick selector 유지)
      const verifyBtn = globalPage.locator('#auth_email_otp button[onclick="login();"]').first();
      await verifyBtn.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await verifyBtn.click({ force: true }).catch(() => {});

      await globalPage.waitForTimeout(6000);

      console.log('[STEP 3] 인증 후 URL:', globalPage.url());

      if (globalPage.url().includes('soffice.11st.co.kr')) {
        console.log('[STEP 3-1] ✅ 인증 완료 → 세션 저장');
        await globalPage.context().storageState({ path: 'auth.json' });
        return res.json({ status: 'SUCCESS', message: '인증 완료' });
      } else {
        console.log('[STEP 3-2] ⚠️ 인증 후에도 셀러오피스 진입 안됨');
        const shot = await takeScreenshot(globalPage, 'verify-failed');
        await clearSession('verify_failed');
        return res.json({
          status: 'ERROR',
          message: '인증 후 셀러오피스 진입 실패. 다시 로그인하세요.',
          needsLogin: true,
          screenshot: shot,
          screenshot_label: 'verify-failed',
        });
      }
    }

    // ============================
    // 액션: scrape
    // ============================
    if (action === 'scrape') {
      console.log('[STEP 1] Scrape initiated.');

      if (!globalPage) {
        console.log('[STEP 1-1] ⚠️ 세션 없음 → 초기화');
        await clearSession('no_page_on_scrape');
        return res.json({
          status: 'ERROR',
          message: 'Session not found. Please login first.',
          needsLogin: true,
        });
      }

      console.log('[STEP 1-2] 현재 페이지 URL:', globalPage.url());

      console.log('[STEP 2] Navigating to Stock Page...');
      await globalPage.goto('https://soffice.11st.co.kr/view/40394', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      console.log('[STEP 2-1] 페이지 로드 완료, iframe 로딩 대기 (15초)...');
      await globalPage.waitForTimeout(15000);

      await takeScreenshot(globalPage, 'stock-page-loaded');
      console.log('[STEP 2-2] 현재 URL:', globalPage.url());

      // 세션 만료 감지 → 자동 초기화
      if (globalPage.url().includes('login.11st.co.kr')) {
        console.log('[STEP 2-3] ⚠️ 세션 만료 감지 → 세션 초기화');
        const shot = await takeScreenshot(globalPage, 'session-expired');
        await clearSession('session_expired_on_scrape');
        return res.json({
          status: 'ERROR',
          message: '세션 만료됨 - 세션 초기화 완료. 다시 로그인하세요.',
          needsLogin: true,
          screenshot: shot,
          screenshot_label: 'session-expired',
        });
      }

      // 프레임 탐색 (3회 재시도)
      console.log('[STEP 3] iframe 내 검색 버튼 탐색 시작...');
      let targetFrame = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[STEP 3-${attempt}] 프레임 탐색 시도 ${attempt}/${maxRetries}`);

        const allFrames = globalPage.frames();
        console.log(`[STEP 3-${attempt}] 발견된 프레임 수: ${allFrames.length}`);
        for (let i = 0; i < allFrames.length; i++) {
          const frameUrl = allFrames[i].url();
          console.log(`  - Frame[${i}]: ${frameUrl.substring(0, 120)}`);
        }

        for (const frame of allFrames) {
          try {
            const btnCount = await frame.locator('#btnSearch').count();
            if (btnCount > 0) {
              targetFrame = frame;
              console.log(`[STEP 3-${attempt}] ✅ 검색 버튼 발견!`);
              break;
            }
          } catch (e) {
            // 프레임 접근 에러 무시
          }
        }

        if (targetFrame) break;

        if (attempt < maxRetries) {
          console.log(`[STEP 3-${attempt}] 검색 버튼 못 찾음 → 5초 후 재시도...`);
          await globalPage.waitForTimeout(5000);
        }
      }

      if (!targetFrame) {
        console.error('[STEP 3] FAIL - 검색 버튼 프레임 못 찾음');
        const shot = await takeScreenshot(globalPage, 'frame-not-found');
        await clearSession('frame_not_found');
        return res.json({
          status: 'ERROR',
          message: 'Frame not found (3회 재시도 실패). 세션 초기화됨, 다시 로그인하세요.',
          needsLogin: true,
          screenshot: shot,
          screenshot_label: 'frame-not-found',
          debug_url: globalPage.url(),
          debug_frame_count: globalPage.frames().length,
        });
      }

      console.log('[STEP 4] Clicking Search Button...');
      await targetFrame.click('#btnSearch', { force: true });
      await globalPage.waitForTimeout(5000);

      console.log('[STEP 5] Ensuring Excel Download button is ready...');
      const downloadBtn = targetFrame.locator('button:has-text("엑셀다운로드")');
      await downloadBtn.scrollIntoViewIfNeeded().catch(() => {});

      console.log('[STEP 6] Waiting for Download event (timeout 60s)...');

      try {
        const [download] = await Promise.all([
          globalPage.waitForEvent('download', { timeout: 60000 }),
          downloadBtn.click({ force: true }),
        ]);

        const filePath = `./temp_stock_${Date.now()}.xls`;
        console.log(`[STEP 7] Saving file to ${filePath}...`);
        await download.saveAs(filePath);

        console.log('[STEP 8] Processing Excel Data...');
        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        const finalData = rawData.slice(1).map((row) => {
          const obj = {};
          for (let i = 0; i < 36; i++) {
            let val = row[i] === undefined || row[i] === null ? '' : String(row[i]).trim();

            // 숫자 컬럼 콤마 제거(기존 로직 유지)
            if ([0, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 30].includes(i)) {
              val = val.replace(/,/g, '') || '0';
            }

            obj[`col_${i}`] = val;
          }
          return obj;
        });

        fs.unlinkSync(filePath);

        console.log(`[STEP 9] ✅ Success! Collected ${finalData.length} items.`);
        return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });
      } catch (downloadErr) {
        console.error('[STEP 6 ERROR] Download failed:', downloadErr.message);
        const shot = await takeScreenshot(globalPage, 'download-error');
        return res.json({
          status: 'ERROR',
          message: `Download Timeout: ${downloadErr.message}`,
          needsLogin: false,
          screenshot: shot,
          screenshot_label: 'download-error',
        });
      }
    }

    // ============================
    // 액션 미일치
    // ============================
    console.log('[STEP X] unknown action');
    return res.json({ status: 'ERROR', message: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[FATAL ERROR] message:', err.message);
    console.error('[FATAL ERROR] stack:', err.stack);

    const shot = await takeScreenshot(globalPage, 'fatal-error');

    // 치명적 에러 → 세션 완전 초기화
    await clearSession('fatal_error');

    return res.json({
      status: 'ERROR',
      message: err.message,
      needsLogin: true,
      screenshot: shot,
      screenshot_label: 'fatal-error',
    });
  }
}

module.exports = { execute };
