const { chromium } = require('playwright');
const express = require('express');
const app = express();
app.use(express.json());

// 환경 변수에서 ID와 PW를 가져옵니다.
const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];

app.post('/execute', async (req, res) => {
    const { action, authCode } = req.body;
    
    // 브라우저 실행 설정 (서버 환경에 맞춰 headless: true)
    const browser = await chromium.launch({ 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        if (action === 'login') {
            console.log('📍 [11번가] 로그인 시작...');
            await page.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            
            // 이미지에서 확인한 ID/PW 입력창 selector 사용
            await page.fill('#loginName', USER_ID);
            await page.fill('#passWord', USER_PW);
            
            // 로그인 버튼 클릭
            await page.click('button.c-button--submit');
            await page.waitForTimeout(3000); // 페이지 전환 대기

            // 2단계 인증 페이지(이미지 4번) 확인
            const isAuthPage = await page.isVisible('button.button_style_01');
            
            if (isAuthPage) {
                console.log('📍 [11번가] 2단계 인증 필요 - 메일 발송 클릭');
                await page.click('button.button_style_01'); // 인증정보 선택하기 버튼
                return res.json({ status: 'AUTH_REQUIRED', message: '네이버웍스 메일을 확인해주세요.' });
            }
            
            return res.json({ status: 'SUCCESS', message: '로그인 성공' });
        }

        // 인증번호 입력 시나리오
        if (action === 'verify') {
            // n8n에서 받아온 authCode를 입력하는 로직 (추후 구현)
            console.log('📍 인증번호 입력 시도:', authCode);
        }

    } catch (error) {
        console.error('에러 발생:', error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    } finally {
        await browser.close();
    }
});

app.listen(8080, () => console.log('Playwright server running on :8080'));
