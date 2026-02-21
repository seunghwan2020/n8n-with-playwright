const { chromium } = require('playwright');
const express = require('express');
const app = express();
app.use(express.json());

const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];

// 🌟 로봇이 퇴근하지 않고 기다릴 '대기실' (전역 변수 설정)
let globalBrowser = null;
let globalPage = null;

app.post('/execute', async (req, res) => {
    const { action, authCode } = req.body;
    
    try {
        if (action === 'login') {
            // 이전에 켜둔 로봇이 있다면 정리하고 새로 시작
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await globalBrowser.newContext({ viewport: { width: 1280, height: 800 } });
            globalPage = await context.newPage();

            // 🌟 매우 중요: 화면에 팝업창(alert)이 뜨면 무조건 '확인'을 누르도록 로봇에게 미리 지시
            globalPage.on('dialog', async dialog => {
                console.log('📍 팝업 등장, 알아서 [확인] 누름:', dialog.message());
                await dialog.accept();
            });

            console.log('📍 [11번가] 로그인 시작...');
            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            
            await globalPage.fill('#loginName', USER_ID);
            await globalPage.fill('#passWord', USER_PW);
            await globalPage.click('button.c-button--submit');
            await globalPage.waitForTimeout(4000); // 화면 전환 대기

            // 1단계: "인증정보 선택하기" 버튼이 있는 화면 (이미지 1)
            const isOperatorPage = await globalPage.isVisible('button.button_style_01:has-text("인증정보 선택하기")');
            if (isOperatorPage) {
                await globalPage.click('button.button_style_01:has-text("인증정보 선택하기")');
                await globalPage.waitForTimeout(2000);
            }

            // 2단계: 이메일 선택 및 전송 (이미지 2, 3, 4)
            const isEmailSelectPage = await globalPage.isVisible('label[for="auth_type_02"]');
            if (isEmailSelectPage) {
                console.log('📍 이메일 인증 선택 및 발송 버튼 클릭');
                await globalPage.click('label[for="auth_type_02"]'); // '이메일' 라디오 버튼 클릭
                await globalPage.click('button[onclick="requestOTP();"]'); // '인증번호 전송' 클릭
                
                await globalPage.waitForTimeout(3000); // 메일 발송 및 팝업 닫히는 시간 대기
                
                // 🌟 브라우저를 닫지 않고 n8n에게 응답만 보냄
                return res.json({ status: 'AUTH_REQUIRED', message: '인증 메일이 발송되었습니다. 대기 중...' });
            }

            return res.json({ status: 'SUCCESS', message: '로그인 성공 (인증 불필요)' });
        }

        // ==========================================
        // 새로 추가된 기능: n8n이 메일에서 찾은 번호를 입력하는 단계
        // ==========================================
        if (action === 'verify') {
            if (!globalPage) {
                return res.status(400).json({ status: 'ERROR', message: '로봇이 켜져 있지 않습니다. login부터 다시 하세요.' });
            }
            
            console.log('📍 n8n으로부터 인증번호 전달받음:', authCode);
            
            // 3단계: 전달받은 인증번호 입력 (이미지 5)
            await globalPage.fill('#auth_num_email', authCode);
            
            // 4단계: 최종 '확인' 버튼 클릭 (이미지 6)
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            
            await globalPage.waitForTimeout(5000); // 메인 페이지로 넘어갈 때까지 충분히 대기

            const currentUrl = globalPage.url();
            return res.json({ status: 'VERIFIED', message: '최종 인증 완료!', url: currentUrl });
        }

    } catch (error) {
        console.error('에러 발생:', error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    }
    // 🌟 주의: finally 부분에 있던 await browser.close(); 를 삭제했습니다. 
    // 로봇이 임의로 퇴근하면 안 되기 때문입니다.
});

app.listen(8080, () => console.log('Playwright server running on :8080'));
