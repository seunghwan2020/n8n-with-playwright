const { chromium } = require('playwright');
const express = require('express');
const app = express();
app.use(express.json());

app.post('/execute', async (req, res) => {
    const { action, id, pw, authCode } = req.body;
    const browser = await chromium.launch({ headless: true }); // 눈에 안 보이게 실행
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        if (action === 'login') {
            // 1. 로그인 페이지 접속
            await page.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            
            // 2. ID/PW 입력 (보내주신 소스 기반 id 사용)
            await page.fill('#loginName', id);
            await page.fill('#passWord', pw);
            
            // 3. 로그인 버튼 클릭 (c-button--submit 클래스 기반)
            await page.click('button.c-button--submit');
            
            // 4. 2단계 인증 화면 대기
            await page.waitForTimeout(2000);
            
            // "인증정보 선택하기" 버튼이 있는지 확인 (보내주신 4페이지 이미지)
            const isAuthPage = await page.isVisible('button.button_style_01');
            
            if (isAuthPage) {
                // 첫 번째 인증 수단(메일) 선택 후 클릭
                await page.click('button.button_style_01');
                return res.json({ status: 'AUTH_REQUIRED', message: '인증 메일이 발송되었습니다.' });
            }
        } 
        
        // 이후 인증번호 입력 및 재고 수집 로직은 워크플로우 진행에 따라 추가 구현 가능
        
    } catch (error) {
        res.status(500).json({ status: 'ERROR', error: error.message });
    } finally {
        await browser.close();
    }
});

app.listen(8080, () => console.log('Playwright server listening on :8080'));
