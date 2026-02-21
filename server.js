const express = require('express');
const { chromium } = require('playwright');
const app = express();

app.use(express.json());

// n8n에서 찔러주는 URL
app.post('/run', async (req, res) => {
    // n8n Body에서 보낸 타겟, 아이디, 비밀번호를 꺼냅니다.
    const { target, id, pw } = req.body; 
    
    if (target === 'naver_inventory') {
        try {
            const result = await runNaverScraper(id, pw);
            res.json({ success: true, data: result });
        } catch (error) {
            console.error('크롤링 중 에러 발생:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        res.status(400).json({ error: '알 수 없는 target 입니다.' });
    }
});

// 네이버 실제 작동 로직
async function runNaverScraper(naverId, naverPw) {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    console.log('1. 네이버 로그인 페이지 이동 중...');
    await page.goto('https://accounts.commerce.naver.com/login?url=https%3A%2F%2Fsell.smartstore.naver.com%2F%23%2Flogin-callback');

    // 2. 아이디/비밀번호 입력 후 로그인 클릭
    await page.evaluate(({id, pw}) => {
        document.querySelector('input[name="id"]').value = id;
        document.querySelector('input[name="pw"]').value = pw;
    }, { id: naverId, pw: naverPw });
    await page.click('button[type="submit"]');

    // ==========================================
    // 💡 [여기서부터 2단계 인증 방지 코드입니다] 💡
    // ==========================================
    console.log('🔒 2단계 인증 화면인지 확인 중...');
    const isTwoFactorScreen = await page.locator('text=인증정보 선택하기').isVisible({ timeout: 5000 }).catch(() => false);

    if (isTwoFactorScreen) {
        console.log('2단계 인증 감지됨! 메일 옵션을 헤매지 않고 디폴트 상태로 바로 진행합니다.');
        // 특정 이메일(예: nldList_0)을 찾으려고 시도하지 않고, 바로 버튼을 누릅니다.
        await page.click('button:has-text("인증정보 선택하기")');
        
        // 인증번호가 메일로 발송될 시간을 잠시 기다려줍니다.
        await page.waitForTimeout(3000); 
    }
    // ==========================================

    console.log('3. N배송 재고관리 페이지로 이동 중...');
    await page.goto('https://sell.smartstore.naver.com/#/logistics/sku-management/information');
    
    // 보내주신 첫 번째 이미지의 개발자 도구를 참고하여 '검색' 버튼을 누릅니다.
    await page.waitForSelector('.css-v3t7n8');
    await page.click('button:has-text("검색")');
    
    console.log('데이터 로딩 대기 중...');
    await page.waitForTimeout(3000); // 표가 뜰 때까지 3초 대기

    // 임시로 성공 메시지 반환 (다음 단계에서 이 부분에 표 데이터를 긁어오는 코드를 넣을 겁니다)
    const resultMessage = "로그인 및 검색 버튼 클릭까지 성공했습니다!";

    await browser.close();
    return resultMessage;
}

app.listen(8080, () => console.log('서버가 8080 포트에서 실행 대기 중입니다.'));
