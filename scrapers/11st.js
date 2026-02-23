// ============================================
// [11st.js] - 11번가 셀러오피스 로그인 & 재고 크롤링
// 수정사항: 스크린샷 디버깅 추가 + 프레임 탐색 강화
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
// 🔧 스크린샷 유틸리티 함수
// - 현재 화면을 찍어서 base64 문자열로 반환
// - 에러 발생 시 응답에 포함시켜 디버깅 가능
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
// 메일에서 인증코드 가져오기 (기존과 동일)
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
        // 액션: login
        // ============================
        if (action === 'login') {
            console.log('STEP 1: Starting Login...');

            if (globalBrowser) {
                console.log('[STEP 1-1] 기존 브라우저 종료');
                await globalBrowser.close().catch(() => {});
            }

            console.log('[STEP 1-2] 새 브라우저 시작');
            globalBrowser = await chromium.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            let contextOptions = { viewport: { width: 1400, height: 1000 } };
            if (fs.existsSync('auth.json')) {
                console.log('[STEP 1-3] 저장된 세션(auth.json) 발견 → 재사용');
                contextOptions.storageState = 'auth.json';
            }

            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();
            globalPage.on('dialog', async dialog => await dialog.accept());

            // 🔧 수정: waitUntil + timeout 추가
            console.log('STEP 2: 로그인 페이지 이동 중...');
            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await globalPage.waitForTimeout(4000);

            // 이미 로그인된 상태인지 확인
            const currentUrl = globalPage.url();
            console.log('[STEP 2-1] 현재 URL:', currentUrl);

            if (currentUrl.includes('soffice.11st.co.kr')) {
                console.log('STEP 2: 이미 로그인된 상태!');
                return res.json({ status: 'SUCCESS', message: '이미 로그인됨 (세션 재사용)' });
            }

            // 🔧 추가: 로그인 페이지 스크린샷
            const loginPageShot = await takeScreenshot(globalPage, 'login-page-loaded');

            console.log('STEP 3: ID/PW 입력 중...');
            await globalPage.fill('#loginName', USER_ID);
            await globalPage.fill('#passWord', USER_PW);
            await globalPage.click('button.c-button--submit');
            await globalPage.waitForTimeout(4000);

            // 로그인 후 URL 확인
            console.log('[STEP 3-1] 로그인 후 URL:', globalPage.url());

            if (await globalPage.isVisible('button:has-text("인증정보 선택하기")')) {
                console.log('STEP 4: 인증정보 선택 팝업 감지');
                await globalPage.click('button:has-text("인증정보 선택하기")');
                await globalPage.waitForTimeout(2000);
            }

            if (await globalPage.isVisible('label[for="auth_type_02"]')) {
                console.log('STEP 5: 이메일 인증 필요 → 인증번호 전송');
                await globalPage.click('label[for="auth_type_02"]');
                globalOtpRequestTime = Date.now() - 60000;
                await globalPage.click('button:has-text("인증번호 전송"):visible');
                return res.json({ status: 'AUTH_REQUIRED', message: '이메일 인증번호 전송됨' });
            }

            console.log('STEP 6: 로그인 성공 → 세션 저장');
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS', message: '로그인 성공' });
        }

        // ============================
        // 액션: verify_auto
        // ============================
        if (action === 'verify_auto') {
            console.log('STEP 1: 이메일 인증코드 자동 확인 시작');
            const code = await getAuthCodeFromMail();
            if (!code) {
                console.log('STEP 1: 아직 인증 메일 없음 → 대기');
                return res.json({ status: 'WAIT', message: '인증 메일 대기 중' });
            }

            console.log(`STEP 2: 인증코드 입력: ${code}`);
            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000);

            console.log('STEP 3: 인증 완료 → 세션 저장');
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS', message: '인증 완료' });
        }

        // ============================
        // 액션: scrape
        // ============================
        if (action === 'scrape') {
            console.log('STEP 1: Scrape initiated.');
            if (!globalPage) {
                throw new Error('Session not found. Please login first.');
            }

            // 🔧 수정: 재고 페이지 이동 전 현재 상태 확인
            console.log('[STEP 1-1] 현재 페이지 URL:', globalPage.url());

            console.log('STEP 2: Navigating to Stock Page...');
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });

            // 🔧 수정: 10초 → 15초 대기 + 중간 상태 로그
            console.log('[STEP 2-1] 페이지 로드 완료, iframe 로딩 대기 중 (15초)...');
            await globalPage.waitForTimeout(15000);

            // 🔧 추가: 페이지 이동 후 스크린샷
            const stockPageShot = await takeScreenshot(globalPage, 'stock-page-loaded');
            console.log('[STEP 2-2] 현재 URL:', globalPage.url());

            // 🔧 추가: 혹시 로그인이 풀려서 로그인 페이지로 돌아갔는지 확인
            if (globalPage.url().includes('login.11st.co.kr')) {
                const shot = await takeScreenshot(globalPage, 'session-expired');
                return res.json({
                    status: 'ERROR',
                    message: '세션 만료됨 - 다시 로그인 필요',
                    screenshot: shot,
                    screenshot_label: 'session-expired'
                });
            }

            // 🔧 수정: 프레임 탐색 강화 - 여러 번 재시도
            console.log('STEP 3: iframe 내 검색 버튼 탐색 시작...');
            let targetFrame = null;
            const maxRetries = 3;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                console.log(`[STEP 3-${attempt}] 프레임 탐색 시도 ${attempt}/${maxRetries}`);

                // 모든 프레임 목록 출력 (디버깅용)
                const allFrames = globalPage.frames();
                console.log(`[STEP 3-${attempt}] 발견된 프레임 수: ${allFrames.length}`);
                for (let i = 0; i < allFrames.length; i++) {
                    const frameUrl = allFrames[i].url();
                    console.log(`  - Frame[${i}]: ${frameUrl.substring(0, 120)}`);
                }

                // 각 프레임에서 #btnSearch 찾기
                for (const frame of allFrames) {
                    try {
                        const btnCount = await frame.locator('#btnSearch').count();
                        if (btnCount > 0) {
                            targetFrame = frame;
                            console.log(`[STEP 3-${attempt}] ✅ 검색 버튼 발견! Frame URL: ${frame.url().substring(0, 120)}`);
                            break;
                        }
                    } catch (e) {
                        // 프레임 접근 에러 무시 (크로스오리진 등)
                    }
                }

                if (targetFrame) break;

                if (attempt < maxRetries) {
                    console.log(`[STEP 3-${attempt}] 검색 버튼 못 찾음 → ${5}초 후 재시도...`);
                    await globalPage.waitForTimeout(5000);
                }
            }

            // 🔧 수정: 프레임 못 찾으면 스크린샷 포함해서 에러 반환
            if (!targetFrame) {
                console.error('STEP 3: FAIL - 모든 재시도 후에도 검색 버튼 프레임 못 찾음');
                const shot = await takeScreenshot(globalPage, 'frame-not-found');
                return res.json({
                    status: 'ERROR',
                    message: 'Frame with search button not found (3회 재시도 실패)',
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
                console.log(`STEP 9: Success! Collected ${finalData.length} items.`);
                return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });

            } catch (downloadErr) {
                console.error('STEP 6 ERROR: Download failed or timed out.', downloadErr.message);
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
        // 🔧 추가: 치명적 에러에도 스크린샷 포함
        const shot = await takeScreenshot(globalPage, 'fatal-error');
        return res.json({
            status: 'ERROR',
            message: err.message,
            screenshot: shot,
            screenshot_label: 'fatal-error'
        });
    }
}

module.exports = { execute };
