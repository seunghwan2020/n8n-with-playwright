const { chromium } = require('playwright');
const express = require('express');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;

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
                
                if (mailDate < globalOtpRequestTime) {
                    return null; 
                }

                await client.messageFlagsAdd(latestSeq, ['\\Seen']);

                const mailText = mail.text || mail.html;
                const match = mailText.match(/\d{6,8}/);
                if (match) authCode = match[0];
            }
        }
    } catch (err) {
        console.error('메일 읽기 에러:', err);
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
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await globalBrowser.newContext({ viewport: { width: 1280, height: 800 } });
            globalPage = await context.newPage();

            globalPage.on('dialog', async dialog => {
                await dialog.accept();
            });

            console.log('📍 [11번가] 로그인 시작...');
            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            
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
                
                return res.json({ status: 'AUTH_REQUIRED', message: '인증 메일 발송 완료. 대기 중...' });
            }

            return res.json({ status: 'SUCCESS', message: '로그인 성공 (2차 인증 생략됨)' });
        }

        if (action === 'verify_auto') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '먼저 login을 실행해주세요.' });
            
            const currentUrl = globalPage.url();
            if (currentUrl.includes('soffice.11st.co.kr')) {
                return res.json({ status: 'SUCCESS', message: '이미 접속해 있습니다 (인증 불필요)' });
            }

            const isInputReady = await globalPage.isVisible('#auth_num_email');
            if (!isInputReady) {
                return res.json({ status: 'CHECK_REQUIRED', message: '인증번호 입력창이 없습니다.' });
            }

            const code = await getAuthCodeFromMail();
            if (!code) {
                return res.json({ status: 'WAIT', message: '아직 메일이 안 왔거나 옛날 메일만 있습니다.' });
            }

            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000); 

            return res.json({ status: 'SUCCESS', message: '최종 로그인 완벽 성공!' });
        }

        // =========================================================
        // 🌟 수정된 단계: 보호막 뚫기 및 스크린샷 에러 잡기
        // =========================================================
        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '먼저 로그인을 진행해주세요.' });

            try {
                console.log('📍 재고 관리 페이지 이동 중...');
                // 🌟 무한 로딩 해결 1: 'domcontentloaded' 옵션으로 쓸데없는 스크립트 대기 생략
                await globalPage.goto('https://soffice.11st.co.kr/view/40394', { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });
                
                await globalPage.waitForTimeout(5000); // 넉넉히 대기

                console.log('📍 검색 버튼 클릭...');
                // 🌟 무한 로딩 해결 2: { force: true } 옵션으로 투명 보호막 무시하고 버튼 강제 클릭
                await globalPage.click('#btnSearch', { force: true, timeout: 10000 });
                
                await globalPage.waitForTimeout(5000); // 데이터 뜰 때까지 대기

                console.log('📍 데이터 추출 시작...');
                const gridData = await globalPage.evaluate(() => {
                    const rows = document.querySelectorAll('#SKUListGrid div[role="row"]');
                    const result = [];
                    
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('div[role="gridcell"]');
                        if (cells.length > 0) {
                            const rowObj = {};
                            cells.forEach((cell, idx) => {
                                rowObj[`col_${idx}`] = cell.innerText.trim();
                            });
                            result.push(rowObj);
                        }
                    });
                    return result;
                });

                return res.json({ 
                    status: 'SUCCESS', 
                    message: '데이터 추출 성공',
                    count: gridData.length,
                    data: gridData 
                });

            } catch (err) {
                // 🌟 무한 로딩 해결 3: 에러가 나면 무한 대기하지 않고, 사진을 찍어서 즉시 n8n으로 반환
                console.log('📍 스크래핑 중 막힘 발생. 스크린샷 캡처 중...');
                const screenshot = await globalPage.screenshot({ encoding: 'base64' });
                return res.json({ 
                    status: 'ERROR', 
                    message: '화면에서 막혔습니다: ' + err.message,
                    screenshot: 'data:image/png;base64,' + screenshot 
                });
            }
        }

    } catch (error) {
        console.error('에러 발생:', error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    }
});

app.listen(8080, () => console.log('Playwright server running on :8080'));
