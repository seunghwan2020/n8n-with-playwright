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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
        });
        
        console.log('📍 [STEP 2] 브라우저 실행 성공! 새 탭을 엽니다...');
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 } 
        }); 
        
        const page = await context.newPage();

        console.log('📍 [STEP 3] 네이버 로그인 페이지 접속 시도 중...');
        await page.goto('https://sell.smartstore.naver.com/#/login', { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });

        console.log('📍 [STEP 4] 네이버 페이지 접속 완료! ID/PW 입력을 시작합니다...');
        
        // 💡 1. 봇 탐지 우회를 위해 사람처럼 클릭하고 한 글자씩 타이핑합니다 (pressSequentially 사용)
        const idInput = page.locator('input[placeholder="아이디 또는 이메일 주소"]');
        await idInput.waitFor({ state: 'visible' });
        await idInput.click({ delay: 50 });
        await idInput.pressSequentially(NAV_USER, { delay: 150 }); 

        const pwInput = page.locator('input[placeholder="비밀번호"]');
        await pwInput.click({ delay: 50 });
        await pwInput.pressSequentially(NAV_PW, { delay: 150 });

        console.log('📍 [STEP 4-1] 로그인 버튼 클릭');
        const loginBtn = page.locator('button').filter({ hasText: /^로그인$/ }).first();
        await loginBtn.click({ delay: 100 });

        // 네이버 서버 응답 및 페이지 전환을 위해 5초 대기
        await page.waitForTimeout(5000);

        console.log(`📍 [STEP 5] 클릭 후 현재 페이지 URL: ${page.url()}`);

        // 💡 2. URL 꼼수가 아닌, 실제로 비밀번호 입력창이 아직도 화면에 있는지(로그인 실패) 확인합니다.
        const isStillOnLoginPage = await pwInput.isVisible().catch(() => false);
        
        if (isStillOnLoginPage) {
            console.log('⚠️ 경고: 로그인에 실패하여 아직 로그인 화면에 갇혀있습니다!');
            
            // 네이버가 화면에 띄운 에러 텍스트(캡차, 비번 오류 등)를 모두 긁어서 출력합니다.
            const errorText = await page.evaluate(() => document.body.innerText);
            console.log(`[네이버 화면 에러 내용]: \n${errorText.substring(0, 300)}...`);
            
            throw new Error('LOGIN_FAILED: 로그인을 통과하지 못했습니다. Railway 로그의 [네이버 화면 에러 내용]을 확인해 주세요.');
        }

        console.log('🔒 2단계 인증 화면 감지 및 처리 대기...');
        try {
            await page.waitForSelector('text=인증정보 선택하기', { timeout: 5000 });
            console.log('🔒 2단계 인증 화면 감지됨! [인증정보 선택하기] 버튼 클릭!');
            await page.click('text=인증정보 선택하기');
            await page.waitForTimeout(3000); 
        } catch (e) {
            console.log('2단계 인증 화면이 없거나 이미 통과했습니다.');
        }

        console.log('📍 [STEP 6] N배송 재고관리 페이지로 이동 중...');
        await page.goto('https://sell.smartstore.naver.com/#/logistics/sku-management/quantity', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        console.log(`📍 이동된 재고 페이지 URL: ${page.url()}`);

        console.log('📍 [STEP 7] 검색 버튼 클릭 및 결과 대기...');
        const searchBtn = page.locator('button').filter({ hasText: /^검색$/ }).first();
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
        console.error('크롤링 에러 발생:', error.message);
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
