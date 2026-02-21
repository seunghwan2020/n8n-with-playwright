const { chromium } = require('playwright');
const express = require('express');
const app = express();
app.use(express.json());

const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];

app.post('/execute', async (req, res) => {
    const { action } = req.body;
    
    const browser = await chromium.launch({ 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 } // 화면을 넓게 봅니다
    });
    const page = await context.newPage();

    try {
        if (action === 'login') {
            console.log('📍 [11번가] 로그인 프로세스 시작...');
            await page.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            
            await page.fill('#loginName', USER_ID);
            await page.fill('#passWord', USER_PW);
            await page.click('button.c-button--submit');
            
            await page.waitForTimeout(5000);

            // 🔥 사진을 크롬 브라우저 주소창에 바로 띄울 수 있는 텍스트로 완벽 변환
            const imageBuffer = await page.screenshot();
            const screenshot = 'data:image/png;base64,' + imageBuffer.toString('base64');
            const currentUrl = page.url();

            const isAuthPage = await page.isVisible('button.button_style_01');
            if (isAuthPage) {
                await page.click('button.button_style_01');
                await page.waitForTimeout(2000);
                return res.json({ status: 'AUTH_REQUIRED', message: '인증 메일 발송됨', url: currentUrl, screenshot: screenshot });
            }

            if (currentUrl.includes('soffice.11st.co.kr')) {
                return res.json({ status: 'SUCCESS', message: '로그인 성공', url: currentUrl, screenshot: screenshot });
            }

            return res.json({ status: 'CHECK_REQUIRED', message: '화면 확인이 필요합니다.', url: currentUrl, screenshot: screenshot });
        }
    } catch (error) {
        res.status(500).json({ status: 'ERROR', message: error.message });
    } finally {
        await browser.close();
    }
});

app.listen(8080, () => console.log('Playwright server running on :8080'));
