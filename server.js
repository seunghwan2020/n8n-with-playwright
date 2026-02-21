const express = require('express');
const { chromium } = require('playwright');
const app = express();

app.use(express.json());

app.post('/run', async (req, res) => {
    const { target, id, pw } = req.body; 
    let step = "시작 전"; // 현재 진행 단계를 저장할 변수
    
    if (target === 'naver_inventory') {
        let browser;
        try {
            step = "브라우저 실행 중 (버전 확인)";
            browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await browser.newContext();
            const page = await context.newPage();
            
            step = "네이버 로그인 페이지 이동";
            console.log(step);
            await page.goto('https://accounts.commerce.naver.com/login?url=https%3A%2F%2Fsell.smartstore.naver.com%2F%23%2Flogin-callback');

            step = "아이디/비밀번호 입력 및 로그인 버튼 클릭";
            console.log(step);
            await page.evaluate(({naverId, naverPw}) => {
                document.querySelector('input[name="id"]').value = naverId;
                document.querySelector('input[name="pw"]').value = naverPw;
            }, { naverId: id, naverPw: pw });
            await page.click('button[type="submit"]');

            step = "2단계 인증 화면 체크";
            console.log(step);
            const isTwoFactorScreen = await page.locator('text=인증정보 선택하기').isVisible({ timeout: 5000 }).catch(() => false);

            if (isTwoFactorScreen) {
                step = "2단계 인증 화면 통과 시도";
                console.log(step);
                await page.click('button:has-text("인증정보 선택하기")');
                await page.waitForTimeout(3000); 
            }

            step = "N배송 재고관리 페이지로 이동";
            console.log(step);
            await page.goto('https://sell.smartstore.naver.com/#/logistics/sku-management/information');
            
            step = "검색 버튼 클릭 대기";
            console.log(step);
            await page.waitForSelector('.css-v3t7n8');
            await page.click('button:has-text("검색")');
            
            step = "데이터 로딩 대기";
            console.log(step);
            await page.waitForTimeout(3000); 

            await browser.close();
            res.json({ success: true, message: "로그인 및 검색까지 완벽하게 성공했습니다!" });

        } catch (error) {
            // 에러가 났을 때, 브라우저가 열려있으면 강제 종료
            if (browser) await browser.close();
            
            // n8n으로 "어느 단계에서" 에러가 났는지 친절하게 한글로 보냄
            console.error(`[에러 발생 단계: ${step}]`, error.message);
            res.status(500).json({ 
                success: false, 
                failed_step: step, 
                error_detail: error.message 
            });
        }
    } else {
        res.status(400).json({ error: '알 수 없는 target 입니다.' });
    }
});

app.listen(8080, () => console.log('서버가 8080 포트에서 실행 대기 중입니다.'));
