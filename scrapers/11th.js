const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const fs = require('fs');

const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];
const NAVER_USER = process.env['EMAIL_USER'];
const NAVER_PW = process.env['EMAIL_PW'];

let globalBrowser = null;
let globalPage = null;
let globalOtpRequestTime = 0; 

async function getAuthCodeFromMail() {
    const client = new ImapFlow({
        host: 'imap.worksmobile.com',
        port: 993,
        secure: true,
        auth: { user: NAVER_USER, pass: NAVER_PW },
        logger: false
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
        console.error('📍 [11번가 메일 에러]', err);
    } finally {
        lock.release();
        await client.logout();
    }
    return authCode;
}

// 🌟 관제탑에서 넘겨받아 실행할 메인 함수
async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('📍 [11st LOGIN STEP 1] 11번가 접속 준비...');
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            
            let contextOptions = { viewport: { width: 1280, height: 800 } };
            // 폴더가 달라져도 './auth.json'은 최상위(root)를 바라보게 되어 있어 안전합니다.
            if (fs.existsSync('auth.json')) {
                console.log('📍 [11st LOGIN STEP 2] 저장된 세션(쿠키) 발견!');
                contextOptions.storageState = 'auth.json';
            }

            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();

            globalPage.on('dialog', async dialog => await dialog.accept());

            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            await globalPage.waitForTimeout(4000);

            if (globalPage.url().includes('soffice.11st.co.kr')) {
                console.log('📍 [11st LOGIN STEP 3] 세션 유지 확인! 프리패스');
                return res.json({ status: 'SUCCESS', message: '자동 로그인 되었습니다' });
            }

            console.log('📍 [11st LOGIN STEP 4] 로그인 진행...');
            await globalPage.fill('#loginName', USER_ID);
            await globalPage.fill('#passWord', USER_PW);
            await globalPage.click('button.c-button--submit');
            await globalPage.waitForTimeout(4000);

            const isOperatorPage = await globalPage.isVisible('button.button_style_01:has-text("인증정보 선택하기")');
            if (isOperatorPage) {
                await globalPage.click('button.button_style_01:has-text("인증정보 선택하기")');
                await globalPage.waitForTimeout(2000);
            }

            const isEmailSelectPage = await globalPage.isVisible('label[for="auth_type_02"]');
            if (isEmailSelectPage) {
                await globalPage.click('label[for="auth_type_02"]'); 
                await globalPage.waitForTimeout(1000); 
                globalOtpRequestTime = Date.now() - 60000; 
                await globalPage.click('button:has-text("인증번호 전송"):visible'); 
                await globalPage.waitForTimeout(3000); 
                return res.json({ status: 'AUTH_REQUIRED', message: '인증 메일 발송 완료' });
            }

            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS', message: '로그인 성공 (세션 저장)' });
        }

        if (action === 'verify_auto') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: 'login 먼저 실행' });
            if (globalPage.url().includes('soffice.11st.co.kr')) return res.json({ status: 'SUCCESS' });
            
            const code = await getAuthCodeFromMail();
            if (!code) return res.json({ status: 'WAIT', message: '메일 대기 중...' });

            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000); 

            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS', message: '최종 로그인 성공!' });
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '로그인이 필요합니다.' });

            console.log('\n📍 [11st SCRAPE STEP 1] 재고 페이지 이동...');
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await globalPage.waitForTimeout(8000); 

            console.log('📍 [11st SCRAPE STEP 2] 프레임 탐색...');
            let targetFrame = null;
            for(let i = 1; i <= 15; i++) {
                const frames = globalPage.frames();
                for (const frame of frames) {
                    try {
                        if (await frame.locator('#btnSearch').count() > 0) {
                            targetFrame = frame;
                            break;
                        }
                    } catch (e) { }
                }
                if (targetFrame) break; 
                await globalPage.waitForTimeout(1000); 
            }

            if (!targetFrame) throw new Error('검색 버튼을 찾지 못했습니다.');

            console.log('📍 [11st SCRAPE STEP 3] 검색 버튼 꾹 누르기...');
            try {
                await targetFrame.locator('#btnSearch').click({ force: true, delay: 200, timeout: 5000 });
            } catch (clickErr) {
                await targetFrame.evaluate(() => document.querySelector('#btnSearch').click());
            }
            
            console.log('📍 [11st SCRAPE STEP 4] 데이터 대기(10초)...');
            await globalPage.waitForTimeout(10000); 

            console.log('📍 [11st SCRAPE STEP 5] 전체 화면 캡처 중...');
            const imageBuffer = await globalPage.screenshot({ fullPage: true });
            const base64Image = 'data:image/png;base64,' + imageBuffer.toString('base64');

            console.log('📍 [11st SCRAPE STEP 6] 데이터 추출...');
            const gridData = await targetFrame.evaluate(() => {
                const rows = document.querySelectorAll('div[role="row"]');
                const result = [];
                
                rows.forEach(row => {
                    const cells = row.querySelectorAll('div[role="gridcell"]');
                    if (cells.length > 2) {
                        let rowFullText = ''; 
                        const rowObj = {};
                        
                        cells.forEach((cell, idx) => {
                            const text = (cell.textContent || '').replace(/\s+/g, '').trim(); 
                            rowObj[`col_${idx}`] = text;
                            rowFullText += text;
                        });

                        if (rowFullText.length > 5) {
                            result.push(rowObj);
                        }
                    }
                });
                return result;
            });

            console.log(`📍 [11st SCRAPE 완료] ${gridData.length}건 찾음.`);
            return res.json({ 
                status: 'SUCCESS', 
                message: `데이터 추출 종료 (총 ${gridData.length}건)`,
                count: gridData.length,
                data: gridData,
                screenshot_full: base64Image
            });
        }

    } catch (err) {
        console.log(`📍 [11st SCRAPE 에러] ${err.message}`);
        const errImageBuffer = globalPage ? await globalPage.screenshot({ fullPage: true }) : null;
        return res.json({ 
            status: 'ERROR', 
            message: err.message,
            screenshot_full: errImageBuffer ? 'data:image/png;base64,' + errImageBuffer.toString('base64') : null
        });
    }
}

// 모듈 내보내기
module.exports = { execute };
