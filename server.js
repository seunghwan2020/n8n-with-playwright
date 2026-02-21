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
                console.log('📍 팝업 등장, [확인] 누름:', dialog.message());
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
                console.log('📍 이메일 인증 선택 및 메일 발송');
                await globalPage.click('label[for="auth_type_02"]'); 
                await globalPage.waitForTimeout(1000); // 🌟 이메일 선택 후 화면이 바뀔 때까지 1초 대기
                
                // 🌟 에러 해결 핵심 코드: 여러 버튼 중 텍스트가 일치하고 눈에 '보이는' 버튼만 클릭!
                await globalPage.click('button:has-text("인증번호 전송"):visible'); 
                
                await globalPage.waitForTimeout(3000); 
                
                return res.json({ status: 'AUTH_REQUIRED', message: '인증 메일 발송 완료. 대기실에서 대기 중...' });
            }

            return res.json({ status: 'SUCCESS', message: '로그인 성공 (인증 불필요)' });
        }

        if (action === 'verify_auto') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '먼저 login을 실행해주세요.' });
            
            console.log('📍 네이버웍스 메일 확인 중...');
            const code = await getAuthCodeFromMail();

            if (!code) {
                return res.json({ status: 'WAIT', message: '아직 메일이 안 왔거나 번호를 못 찾았습니다.' });
            }

            console.log('📍 획득한 인증번호 입력:', code);
            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            
            await globalPage.waitForTimeout(5000); 

            const currentUrl = globalPage.url();
            return res.json({ status: 'SUCCESS', message: '최종 로그인 완벽 성공!', url: currentUrl });
        }

    } catch (error) {
        console.error('에러 발생:', error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    }
});

app.listen(8080, () => console.log('Playwright server running on :8080'));
