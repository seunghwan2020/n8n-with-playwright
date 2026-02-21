const { chromium } = require('playwright');
const express = require('express');
const app = express();
app.use(express.json());

// 환경 변수 설정
const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];

app.post('/execute', async (req, res) => {
    const { action } = req.body;
    
    // 브라우저 실행 (Railway 환경 최적화)
    const browser = await chromium.launch({ 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

    try {
        if (action === 'login') {
            console.log('📍 [11번가] 로그인 프로세스 시작...');
            await page.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            
            // ID/PW 입력
            await page.fill('#loginName', USER_ID);
            await page.fill('#passWord', USER_PW);
            
            // 로그인 버튼 클릭
            await page.click('button.c-button--submit');
            
            // 클릭 후 페이지 변화를 위해 5초간 대기 (매우 중요)
            await page.waitForTimeout(5000);

            // 현재 화면 스크린샷 찍기 (Base64 형식)
            const screenshot = await page.screenshot({ encoding: 'base64' });
            const currentUrl = page.url();
            console.log('📍 현재 페이지 URL:', currentUrl);

            // 1. 2단계 인증 페이지인 경우 (보내주신 4페이지 소스 기준)
            const isAuthPage = await page.isVisible('button.button_style_01');
            if (isAuthPage) {
                console.log('📍 2단계 인증 버튼 발견 - 메일 발송 시도');
                await page.click('button.button_style_01');
                await page.waitForTimeout(2000);
                return res.json({ 
                    status: 'AUTH_REQUIRED', 
                    message: '인증 메일이 발송되었습니다. 메일을 확인하세요.',
                    url: currentUrl,
                    screenshot: screenshot 
                });
            }

            // 2. 이미 메인 페이지(셀러오피스)로 들어간 경우
            if (currentUrl.includes('soffice.11st.co.kr')) {
                return res.json({ 
                    status: 'SUCCESS', 
                    message: '로그인 성공 (인증 생략됨)',
                    url: currentUrl,
                    screenshot: screenshot
                });
            }

            // 3. 그 외 (로그인 실패나 캡차 등)
            return res.json({ 
                status: 'CHECK_REQUIRED', 
                message: '화면 확인이 필요합니다.',
                url: currentUrl,
                screenshot: screenshot 
            });
        }

    } catch (error) {
        console.error('에러 발생:', error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    } finally {
        await browser.close();
    }
});

app.listen(8080, () => console.log('Playwright server running on :8080'));
