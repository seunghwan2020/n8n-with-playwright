const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// 봇 탐지 우회 플러그인 적용
chromium.use(stealth);

const app = express();
app.use(express.json());

app.post('/scrape-naver-inventory', async (req, res) => {
    const NAV_USER = process.env.NAV_USER;
    const NAV_PW = process.env.NAV_PW;

    if (!NAV_USER || !NAV_PW) {
        return res.status(500).json({ error: '서버에 네이버 계정 환경 변수가 누락되었습니다.' });
    }

    let browser;

    try {
        console.log('로봇이 네이버 스마트스토어 자동 로그인을 시작합니다...');
        console.log('📍 [STEP 1] 브라우저 실행 시도 중...');
        browser = await chromium.launch({ 
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage' 
            ] 
        });
        
        console.log('📍 [STEP 2] 브라우저 실행 성공! 새 탭을 엽니다...');
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }); 
        
        const page = await context.newPage();

        console.log('📍 [STEP 3] 네이버 로그인 페이지 접속 시도 중...');
        await page.goto('https://sell.smartstore.naver.com/#/login', { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        console.log('📍 [STEP 4] 네이버 페이지 접속 완료! ID/PW 입력을 시작합니다...');
        await page.type('input[placeholder="아이디 또는 이메일 주소"]', NAV_USER, { delay: 100 }); 
        await page.type('input[placeholder="비밀번호"]', NAV_PW, { delay: 100 });
        
        // 💡 중요 수정: 로그인 버튼을 누르고 페이지가 실제로 넘어갈 때까지 안전하게 기다립니다.
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => console.log('페이지 이동 대기 완료')),
            page.click('button:has-text("로그인")')
        ]);

        console.log('📍 [STEP 5] 로그인 버튼 클릭 완료! 2단계 인증 대기 중...');

        try {
            await page.waitForSelector('text=인증정보 선택하기', { timeout: 5000 });
            console.log('🔒 2단계 인증 화면 감지됨!');
            console.log('[인증정보 선택하기] 버튼 클릭!');
            await page.click('text=인증정보 선택하기');
        } catch (e) {
            console.log('2단계 인증 화면이 없거나 이미 통과했습니다.');
        }

        // 💡 봇이 캡차에 막혔는지 확인하기 위한 현재 위치 출력
        console.log(`현재 페이지 URL: ${page.url()}`);
        if (page.url().includes('login')) {
            console.log('⚠️ 경고: 아직 로그인 페이지에 머물러 있습니다. 아이디/비밀번호 오류나 보안문자(Captcha)가 발생했을 수 있습니다.');
        }

        console.log('📍 [STEP 6] N배송 재고관리 페이지로 이동 중...');
        await page.goto('https://sell.smartstore.naver.com/#/logistics/sku-management/quantity', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        console.log('📍 [STEP 7] 검색 버튼 클릭 및 결과 대기...');
        console.log(`이동된 재고 페이지 URL: ${page.url()}`);

        // 💡 강력한 선택자: '검색어' 같은 다른 텍스트를 무시하고 정확히 '검색'이라는 버튼만 찾아서 클릭합니다.
        const searchBtn = page.locator('button', { hasText: /^검색$/ }).first();
        // 버튼이 눈에 보일 때까지 최대 15초 대기합니다.
        await searchBtn.waitFor({ state: 'visible', timeout: 15000 });
        await searchBtn.click();

        await page.waitForTimeout(3000);

        console.log('📍 [STEP 8] 표(테이블)에서 재고 데이터 추출 시작...');

        const inventoryData = await page.evaluate(() => {
            const results = [];
            const rows = document.querySelectorAll('div.css-wa81vt');

            rows.forEach(row => {
                const text = row.innerText.trim();
                if (!text) return;

                const columns = text.split(/\n|\t/).map(t => t.trim()).filter(t => t !== '');

                if (columns.length >= 3 && columns[0] !== 'SKU ID') {
                    results.push({
                        sku_id: columns[0],         
                        barcode: columns[1],        
                        product_name: columns[2],   
                        temperature: columns[3],    
                        raw_data: columns
                    });
                }
            });
            return results;
        });

        console.log(`📍 [STEP 9] 총 ${inventoryData.length}개의 데이터 추출 완료. n8n으로 반환합니다.`);

        res.status(200).json(inventoryData);

    } catch (error) {
        console.error('크롤링 에러 발생:', error);
        res.status(500).json({ error: error.message });
    } finally {
        if (browser) {
            await browser.close();
            console.log('브라우저 정상 종료 완료.');
        }
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Playwright server listening on :${PORT}`);
});
