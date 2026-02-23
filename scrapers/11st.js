// ============================================
// [11st.js] - 11번가 셀러오피스 로그인 & 재고 크롤링
// v3: 세션 초기화 로직 추가 + 스크린샷 디버깅 + 프레임 재시도
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
// 메일에서 인증코드 가져오기
// ============================================
async function getAuthCodeFromMail() {
    const client = new ImapFlow({
        host: 'imap.worksmobile.com', port: 993, secure: true,
        auth: { user: NAVER_USER, pass: NAVER_PW }, logger: false
    });
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    let authCode = null;
    try {
        const searchList = await client.search({ unseen: true });
        if (searchList.length > 0) {
            const latestSeq = searchList[searchList.length - 1];
            const message = await client.fetchOne(latestSeq, { source: true });
            if (message && message.source) {
                const mail = await simpleParser(message.source);
                const mailDate = mail.date ? mail.date.getTime() : 0;
                if (mailDate < globalOtpRequestTime) return null;
                await client.messageFlagsAdd(latestSeq, ['\\Seen']);
                const mailText = mail.text || mail.html;
                const match = mailText.match(/\d{6,8}/);
                if (match) authCode = match[0];
            }
        }
    } catch (err) {
        console.error('DEBUG: [MAIL_ERROR]', err);
    } finally {
        lock.release();
        await client.logout();
    }
    return authCode;
}

// ============================================
// 메인 실행 함수
// ============================================
async function execute(action, req, res) {
    try {

        // ============================
        // 액션: reset (수동 세션 초기화)
        // n8n에서 { site: "11st", action: "reset" } 보내면 세션 강제 리셋
        // ============================
        if (action === 'reset') {
            console.log('STEP 1: 수동 세션 초기화 요청');
            await clearSession('manual_reset');
            return res.json({
                status: 'SUCCESS',
                message: '세션 완전 초기화 완료. 다음 요청 시 새로 로그인됩니다.'
            });
        }

        // ============================
        // 액션: login
        // ============================
        if (action === 'login') {
            console.log('STEP 1: Starting Login...');

            // 기존 브라우저만 정리 (auth.json은 일단 유지 → 재사용 시도)
            if (globalBrowser) {
                console.log('[STEP 1-1] 기존 브라우저 종료');
                await globalBrowser.close().catch(() => {});
                globalBrowser = null;
                globalPage = null;
            }

            console.log('[STEP 1-2] 새 브라우저 시작');
            globalBrowser = await chromium.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            let contextOptions = { viewport: { width: 1400, height: 1000 } };
            let usingSavedSession = false;

            if (fs.existsSync('auth.json')) {
                console.log('[STEP 1-3] 저장된 세션(auth.json) 발견 → 재사용 시도');
                contextOptions.storageState = 'auth.json';
                usingSavedSession = true;
            } else {
                console.log('[STEP 1-3] 저장된 세션 없음 → 새로 로그인');
            }

            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();
            globalPage.on('dialog', async dialog => await dialog.accept());

            console.log('STEP 2: 로그인 페이지 이동 중...');
            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await globalPage.waitForTimeout(4000);

            const currentUrl = globalPage.url();
            console.log('[STEP 2-1] 현재 URL:', currentUrl);

            // ✅ 세션 재사용 성공
            if (currentUrl.includes('soffice.11st.co.kr')) {
                console.log('STEP 2: ✅ 세션 재사용 성공! 이미 로그인됨');
                return res.json({ status: 'SUCCESS', message: '세션 재사용 성공' });
            }

            // ⚠️ 세션 재사용 실패 → 만료된 세션 → 초기화 후 새로 로그인
            if (usingSavedSession) {
                console.log('[STEP 2-2] ⚠️ 저장된 세션 만료됨 → 초기화 후 새로 로그인');
                await clearSession('expired_session');

                globalBrowser = await chromium.launch({
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
                const freshContext = await globalBrowser.newContext({
                    viewport: { width: 1400, height: 1000 }
                });
                globalPage = await freshContext.newPage();
                globalPage.on('dialog', async dialog => await dialog.accept());

                console.log('[STEP 2-3] 깨끗한 브라우저로 로그인 페이지 재이동');
                await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall', {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });
                await globalPage.waitForTimeout(4000);
            }

            const loginPageShot = await takeScreenshot(globalPage, 'login-page-loaded');

            console.log('STEP 3: ID/PW 입력 중...');
            await globalPage.fill('#loginName', USER_ID);
            await globalPage.fill('#passWord', USER_PW);
            await globalPage.click('button.c-button--submit');
            await globalPage.waitForTimeout(4000);

            console.log('[STEP 3-1] 로그인 후 URL:', globalPage.url());

            // 로그인 실패 감지
            if (globalPage.url().includes('login.11st.co.kr')) {
                const errorMsg = await globalPage.locator('.error-message, .alert-message, .c-alert')
                    .textContent()
                    .catch(() => null);

                if (errorMsg) {
                    console.error('STEP 3: ❌ 로그인 실패 -', errorMsg);
                    const shot = await takeScreenshot(globalPage, 'login-failed');
                    await clearSession('login_failed');
                    return res.json({
                        status: 'ERROR',
                        message: `로그인 실패: ${errorMsg.trim()}`,
                        screenshot: shot,
                        screenshot_label: 'login-failed'
                    });
                }
            }

// ============================
            // 🔧 2단계 인증 처리 (디버깅 강화 버전)
            // ============================
            if (await globalPage.isVisible('button:has-text("인증정보 선택하기")')) {
                console.log('STEP 4: 2단계 인증 페이지 감지');

                // 📸 인증 페이지 스크린샷
                const authPageShot1 = await takeScreenshot(globalPage, 'auth-page-before-click');

                // 🔧 디버깅: 테이블 HTML 확인
                const tableHtml = await globalPage.evaluate(() => {
                    const table = document.querySelector('table') || document.querySelector('.tbl_list') || document.querySelector('[class*="table"]');
                    return table ? table.outerHTML : 'TABLE NOT FOUND';
                });
                console.log('[STEP 4-DEBUG] 테이블 HTML:', tableHtml);

                // 🔧 디버깅: 페이지 전체에서 radio, input, select 요소 찾기
                const formElements = await globalPage.evaluate(() => {
                    const elements = [];
                    document.querySelectorAll('input[type="radio"], input[type="checkbox"], select, tr, label').forEach(el => {
                        elements.push({
                            tag: el.tagName,
                            type: el.type || '',
                            id: el.id || '',
                            name: el.name || '',
                            className: el.className || '',
                            text: el.textContent?.substring(0, 100) || '',
                            visible: el.offsetParent !== null
                        });
                    });
                    return elements;
                });
                console.log('[STEP 4-DEBUG] 폼 요소들:', JSON.stringify(formElements, null, 2));

                // "인증정보 선택하기" 버튼 클릭
                console.log('[STEP 4-1] "인증정보 선택하기" 버튼 클릭');
                await globalPage.click('button:has-text("인증정보 선택하기")');
                await globalPage.waitForTimeout(5000); // 기존 2초 → 5초로 늘림

                // 📸 클릭 후 스크린샷
                const authPageShot2 = await takeScreenshot(globalPage, 'auth-page-after-click');
                console.log('[STEP 4-2] 클릭 후 URL:', globalPage.url());

                // 🔧 디버깅: 클릭 후 변경된 페이지 HTML 핵심 부분
                const bodyText = await globalPage.evaluate(() => {
                    return document.body.innerText.substring(0, 2000);
                });
                console.log('[STEP 4-DEBUG] 클릭 후 페이지 텍스트:\n', bodyText);

                // 🔧 디버깅: 모든 버튼 텍스트 수집
                const allButtons = await globalPage.evaluate(() => {
                    return Array.from(document.querySelectorAll('button, a.btn, input[type="submit"]')).map(b => ({
                        tag: b.tagName,
                        text: b.textContent?.trim().substring(0, 50) || '',
                        id: b.id || '',
                        visible: b.offsetParent !== null
                    }));
                });
                console.log('[STEP 4-DEBUG] 모든 버튼:', JSON.stringify(allButtons, null, 2));
            }

            // 기존 이메일 인증 라디오버튼 감지 (기존 UI 대응)
            if (await globalPage.isVisible('label[for="auth_type_02"]')) {
                console.log('STEP 5: 이메일 인증 필요 → 인증번호 전송 (기존 UI)');
                await globalPage.click('label[for="auth_type_02"]');
                globalOtpRequestTime = Date.now() - 60000;
                await globalPage.click('button:has-text("인증번호 전송"):visible');
                return res.json({ status: 'AUTH_REQUIRED', message: '이메일 인증번호 전송됨' });
            }

            // 🔧 여기까지 왔으면: 인증 페이지인데 기존 방식으로 처리 불가
            // → 디버깅 정보 포함해서 반환
            const currentPageUrl = globalPage.url();
            if (currentPageUrl.includes('login.11st.co.kr') || currentPageUrl.includes('auth')) {
                console.log('STEP 5: ⚠️ 인증 페이지이지만 처리 방법을 모르는 상태');
                const shotUrl = await takeScreenshot(globalPage, 'auth-unknown-state');
                
                // 페이지 전체 HTML 수집 (디버깅용)
                const fullHtml = await globalPage.evaluate(() => {
                    return document.documentElement.outerHTML;
                });

                return res.json({
                    status: 'AUTH_CHANGED',
                    message: '2단계 인증 UI가 변경된 것 같습니다. 디버깅 정보를 확인하세요.',
                    screenshot_url: shotUrl,
                    debug_url: currentPageUrl,
                    debug_page_html: fullHtml.substring(0, 10000) // 앞 10000자만
                });
            }

            // ✅ 로그인 성공 → 이때만 세션 저장
            console.log('STEP 6: ✅ 로그인 성공 → 세션 저장');
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS', message: '로그인 성공' });
        }

        // ============================
        // 액션: verify_auto
        // ============================
        if (action === 'verify_auto') {
            console.log('STEP 1: 이메일 인증코드 자동 확인 시작');

            if (!globalPage) {
                await clearSession('no_page_on_verify');
                return res.json({
                    status: 'ERROR',
                    message: '브라우저 세션 없음. login부터 다시 시작하세요.',
                    needsLogin: true
                });
            }

            const code = await getAuthCodeFromMail();
            if (!code) {
                console.log('STEP 1: 아직 인증 메일 없음 → 대기');
                return res.json({ status: 'WAIT', message: '인증 메일 대기 중' });
            }

            console.log(`STEP 2: 인증코드 입력: ${code}`);
            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000);

            if (globalPage.url().includes('soffice.11st.co.kr')) {
                console.log('STEP 3: ✅ 인증 완료 → 세션 저장');
                await globalPage.context().storageState({ path: 'auth.json' });
                return res.json({ status: 'SUCCESS', message: '인증 완료' });
            } else {
                console.log('STEP 3: ⚠️ 인증 후에도 셀러오피스 진입 안됨');
                const shot = await takeScreenshot(globalPage, 'verify-failed');
                await clearSession('verify_failed');
                return res.json({
                    status: 'ERROR',
                    message: '인증 후 셀러오피스 진입 실패. 다시 로그인하세요.',
                    needsLogin: true,
                    screenshot: shot,
                    screenshot_label: 'verify-failed'
                });
            }
        }

        // ============================
        // 액션: scrape
        // ============================
        if (action === 'scrape') {
            console.log('STEP 1: Scrape initiated.');

            if (!globalPage) {
                console.log('STEP 1: ⚠️ 세션 없음 → 초기화');
                await clearSession('no_page_on_scrape');
                return res.json({
                    status: 'ERROR',
                    message: 'Session not found. Please login first.',
                    needsLogin: true
                });
            }

            console.log('[STEP 1-1] 현재 페이지 URL:', globalPage.url());

            console.log('STEP 2: Navigating to Stock Page...');
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            console.log('[STEP 2-1] 페이지 로드 완료, iframe 로딩 대기 중 (15초)...');
            await globalPage.waitForTimeout(15000);

            const stockPageShot = await takeScreenshot(globalPage, 'stock-page-loaded');
            console.log('[STEP 2-2] 현재 URL:', globalPage.url());

            // 세션 만료 감지 → 자동 초기화
            if (globalPage.url().includes('login.11st.co.kr')) {
                console.log('STEP 2: ⚠️ 세션 만료 감지 → 세션 초기화');
                const shot = await takeScreenshot(globalPage, 'session-expired');
                await clearSession('session_expired_on_scrape');
                return res.json({
                    status: 'ERROR',
                    message: '세션 만료됨 - 세션 초기화 완료. 다시 로그인하세요.',
                    needsLogin: true,
                    screenshot: shot,
                    screenshot_label: 'session-expired'
                });
            }

            // 프레임 탐색 (3회 재시도)
            console.log('STEP 3: iframe 내 검색 버튼 탐색 시작...');
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
                console.error('STEP 3: FAIL - 검색 버튼 프레임 못 찾음');
                const shot = await takeScreenshot(globalPage, 'frame-not-found');
                await clearSession('frame_not_found');
                return res.json({
                    status: 'ERROR',
                    message: 'Frame not found (3회 재시도 실패). 세션 초기화됨, 다시 로그인하세요.',
                    needsLogin: true,
                    screenshot: shot,
                    screenshot_label: 'frame-not-found',
                    debug_url: globalPage.url(),
                    debug_frame_count: globalPage.frames().length
                });
            }

            console.log('STEP 4: Clicking Search Button...');
            await targetFrame.click('#btnSearch', { force: true });
            await globalPage.waitForTimeout(5000);

            console.log('STEP 5: Ensuring Excel Download button is ready...');
            const downloadBtn = targetFrame.locator('button:has-text("엑셀다운로드")');
            await downloadBtn.scrollIntoViewIfNeeded();

            console.log('STEP 6: Waiting for Download event (timeout 60s)...');
            try {
                const [download] = await Promise.all([
                    globalPage.waitForEvent('download', { timeout: 60000 }),
                    downloadBtn.click({ force: true })
                ]);

                const filePath = `./temp_stock_${Date.now()}.xls`;
                console.log(`STEP 7: Saving file to ${filePath}...`);
                await download.saveAs(filePath);

                console.log('STEP 8: Processing Excel Data...');
                const workbook = XLSX.readFile(filePath);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

                const finalData = rawData.slice(1).map((row) => {
                    const obj = {};
                    for (let i = 0; i < 36; i++) {
                        let val = (row[i] === undefined || row[i] === null) ? "" : String(row[i]).trim();
                        if ([0, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 30].includes(i)) {
                            val = val.replace(/,/g, '') || '0';
                        }
                        obj[`col_${i}`] = val;
                    }
                    return obj;
                });

                fs.unlinkSync(filePath);
                console.log(`STEP 9: ✅ Success! Collected ${finalData.length} items.`);
                return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });

            } catch (downloadErr) {
                console.error('STEP 6 ERROR: Download failed.', downloadErr.message);
                const shot = await takeScreenshot(globalPage, 'download-error');
                return res.json({
                    status: 'ERROR',
                    message: `Download Timeout: ${downloadErr.message}`,
                    screenshot: shot,
                    screenshot_label: 'download-error'
                });
            }
        }

    } catch (err) {
        console.error('FATAL ERROR:', err.message);
        const shot = await takeScreenshot(globalPage, 'fatal-error');
        // 치명적 에러 → 세션 완전 초기화
        await clearSession('fatal_error');
        return res.json({
            status: 'ERROR',
            message: err.message,
            needsLogin: true,
            screenshot: shot,
            screenshot_label: 'fatal-error'
        });
    }
}

module.exports = { execute };
