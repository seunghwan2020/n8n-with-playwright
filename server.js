const { chromium } = require('playwright');
const express = require('express');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const fs = require('fs');

const app = express();
app.use(express.json());

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
        console.error('📍 [메일 에러]', err);
    } finally {
        lock.release();
        await client.logout();
    }
    return authCode;
}

app.post('/execute', async (req, res) => {
    const { action } = req.body;
    
    try {
        if (action === 'login') {
            console.log('📍 [LOGIN STEP 1] 11번가 접속 준비...');
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            
            let contextOptions = { viewport: { width: 1280, height: 800 } };
            if (fs.existsSync('auth.json')) {
                console.log('📍 [LOGIN STEP 2] 저장된 세션(쿠키) 발견! 장착합니다.');
                contextOptions.storageState = 'auth.json';
            }

            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();

            globalPage.on('dialog', async dialog => await dialog.accept());

            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            await globalPage.waitForTimeout(4000);

            if (globalPage.url().includes('soffice.11st.co.kr')) {
                console.log('📍 [LOGIN STEP 3] 세션 유지 확인! 프리패스합니다.');
                return res.json({ status: 'SUCCESS', message: '자동 로그인 되었습니다' });
            }

            console.log('📍 [LOGIN STEP 4] 아이디/비밀번호 입력...');
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
                console.log('📍 [LOGIN STEP 5] 이메일 인증 선택 및 메일 발송...');
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
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: 'login을 먼저 실행하세요.' });
            
            if (globalPage.url().includes('soffice.11st.co.kr')) {
                return res.json({ status: 'SUCCESS', message: '이미 접속해 있습니다' });
            }

            if (!(await globalPage.isVisible('#auth_num_email'))) {
                return res.json({ status: 'CHECK_REQUIRED', message: '인증번호 입력창이 없습니다.' });
            }

            console.log('📍 [VERIFY STEP 1] 메일함에서 인증번호 찾는 중...');
            const code = await getAuthCodeFromMail();
            if (!code) return res.json({ status: 'WAIT', message: '메일 대기 중...' });

            console.log(`📍 [VERIFY STEP 2] 인증번호 [${code}] 입력 및 확인 클릭...`);
            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000); 

            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS', message: '최종 로그인 성공!' });
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '로그인이 필요합니다.' });

            try {
                console.log('\n📍 [SCRAPE STEP 1] 재고 페이지로 이동합니다...');
                await globalPage.goto('https://soffice.11st.co.kr/view/40394', { waitUntil: 'domcontentloaded', timeout: 30000 });
                
                console.log('📍 [SCRAPE STEP 2] 화면 로딩 대기...');
                await globalPage.waitForTimeout(6000); 

                console.log('📍 [SCRAPE STEP 3] 프레임 탐색 시작!');
                let targetFrame = null;
                
                for(let i = 1; i <= 15; i++) {
                    const frames = globalPage.frames();
                    for (const frame of frames) {
                        try {
                            const btnCount = await frame.locator('#btnSearch').count();
                            if (btnCount > 0) {
                                targetFrame = frame;
                                break;
                            }
                        } catch (e) { }
                    }
                    if (targetFrame) break; 
                    await globalPage.waitForTimeout(1000); 
                }

                if (!targetFrame) throw new Error('검색 버튼을 찾지 못했습니다.');

                console.log('📍 [SCRAPE STEP 4] 검색 버튼 클릭!');
                try {
                    await targetFrame.click('#btnSearch', { force: true, timeout: 5000 });
                } catch (clickErr) {
                    await targetFrame.evaluate(() => document.querySelector('#btnSearch').click());
                }
                
                console.log('📍 [SCRAPE STEP 5] 데이터 로딩 대기...');
                await globalPage.waitForTimeout(7000); 

                console.log('📍 [SCRAPE STEP 6] 진짜 데이터 긁어오기 (유령 행 제외)');
                // 🌟 여기서부터 빈칸 필터링 로직이 들어갑니다.
                const gridData = await targetFrame.evaluate(() => {
                    const rows = document.querySelectorAll('div[role="row"]');
                    const result = [];
                    
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('div[role="gridcell"]');
                        // 칸이 충분히 있는지 확인합니다.
                        if (cells.length > 2) {
                            // 2번째 칸(SKU번호) 혹은 3번째 칸(SKU명)의 글자를 확인합니다.
                            const skuNumber = cells[1].innerText.trim();
                            const skuName = cells[2].innerText.trim();

                            // 둘 중 하나라도 내용이 있는 '진짜 데이터'만 배열에 담습니다.
                            if (skuNumber !== '' || skuName !== '') {
                                const rowObj = {};
                                cells.forEach((cell, idx) => {
                                    rowObj[`col_${idx}`] = cell.innerText.trim();
                                });
                                result.push(rowObj);
                            }
                        }
                    });
                    return result;
                });

                console.log(`📍 [SCRAPE 완료] 총 ${gridData.length}개의 찐 데이터를 찾았습니다!`);
                return res.json({ 
                    status: 'SUCCESS', 
                    message: '데이터 추출 성공',
                    count: gridData.length,
                    data: gridData 
                });

            } catch (err) {
                console.log(`📍 [SCRAPE 에러] ${err.message}`);
                const imageBuffer = await globalPage.screenshot();
                const base64Image = imageBuffer.toString('base64');
                return res.json({ 
                    status: 'ERROR', 
                    message: err.message,
                    screenshot: 'data:image/png;base64,' + base64Image 
                });
            }
        }

    } catch (error) {
        console.error('📍 [서버 전체 에러]', error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    }
});

app.listen(8080, () => console.log('Playwright server running on :8080'));
