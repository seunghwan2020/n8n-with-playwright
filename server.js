const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// 봇 탐지 우회 플러그인 적용
chromium.use(stealth);

const app = express();
app.use(express.json());

app.post('/scrape-naver-inventory', async (req, res) => {
    // Railway에 설정한 환경 변수 불러오기
    const NAV_USER = process.env.NAV_USER;
    const NAV_PW = process.env.NAV_PW;

    // 환경 변수 누락 체크
    if (!NAV_USER || !NAV_PW) {
        console.error('환경 변수 오류: NAV_USER 또는 NAV_PW가 설정되지 않았습니다.');
        return res.status(500).json({ error: '서버에 네이버 계정 환경 변수가 누락되었습니다.' });
    }

    let browser;

    try {
        console.log('로봇이 네이버 스마트스토어 자동 로그인을 시작합니다...');
        
        console.log('📍 [STEP 1] 브라우저 실행 시도 중...');
        browser = await chromium.launch({ 
            headless: true, // Railway 환경에서는 반드시 true
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage' // 컨테이너 환경 메모리 크래시 방지용 옵션
            ] 
        });
        
        console.log('📍 [STEP 2] 브라우저 실행 성공! 새 탭을 엽니다...');
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }); // 봇 탐지 우회를 위해 일반 크롬 유저에이전트 명시
        
        const page = await context.newPage();

        console.log('📍 [STEP 3] 네이버 로그인 페이지 접속 시도 중...');
        await page.goto('https://sell.smartstore.naver.com/#/login', { 
            waitUntil: 'domcontentloaded', 
            timeout: 60000 
        });

        console.log('📍 [STEP 4] 네이버 페이지 접속 완료! ID/PW 입력을 시작합니다...');
        
        // 1. ID 입력 (이메일/판매자 아이디) - 사람처럼 타이핑
        await page.type('input[placeholder="아이디 또는 이메일 주소"]', NAV_USER, { delay: 100 }); 
        
        // 2. 비밀번호 입력
        await page.type('input[placeholder="비밀번호"]', NAV_PW, { delay: 100 });
        
        // 3. 로그인 버튼 클릭
        await page.click('button:has-text("로그인")');

        console.log('📍 [STEP 5] 로그인 버튼 클릭 완료! 2단계 인증 대기 중...');

        // 🔒 2단계 인증 화면 감지 및 처리
        try {
            await page.waitForSelector('text=인증정보 선택하기', { timeout: 5000 });
            console.log('🔒 2단계 인증 화면 감지됨!');
            
            // 이메일 옵션을 찾으며 헤매지 않고, 디폴트로 둔 상태에서 즉시 버튼을 클릭합니다.
            console.log('[인증정보 선택하기] 버튼 클릭!');
            await page.click('text=인증정보 선택하기');
            
        } catch (e) {
            console.log('2단계 인증 화면이 없거나 이미 통과했습니다.');
        }

        console.log('📍 [STEP 6] N배송 재고관리 페이지로 이동 중...');
        // 페이지 이동 후 네트워크 요청(API 데이터 호출 등)이 잦아들 때까지 대기합니다.
        await page.goto('https://sell.smartstore.naver.com/#/logistics/sku-management/quantity', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        console.log('📍 [STEP 7] 검색 버튼 클릭 및 결과 대기...');
        // '검색' 텍스트를 가진 버튼을 클릭합니다.
        await page.click('button:has-text("검색")');

        // 검색 결과(데이터)가 화면에 완전히 그려질 수 있도록 3초 정도 넉넉히 기다려줍니다.
        await page.waitForTimeout(3000);

        console.log('📍 [STEP 8] 표(테이블)에서 재고 데이터 추출 시작...');

        // 캡처된 DOM 구조(div.css-wa81vt 등)를 기반으로 브라우저 내부에서 데이터를 추출합니다.
        const inventoryData = await page.evaluate(() => {
            const results = [];
            // 화면 캡처에서 확인된 행(Row) 컨테이너 클래스를 타겟으로 지정합니다.
            const rows = document.querySelectorAll('div.css-wa81vt');

            rows.forEach(row => {
                // 각 행 안의 텍스트를 가져와서 줄바꿈(\n)이나 탭(\t) 단위로 쪼갭니다.
                const text = row.innerText.trim();
                if (!text) return;

                const columns = text.split(/\n|\t/).map(t => t.trim()).filter(t => t !== '');

                // 헤더(제목) 행은 제외하고 실제 데이터만 추출
                // 통상적으로 첫 번째 컬럼이 SKU ID이므로 이를 기준으로 삼습니다.
                if (columns.length >= 3 && columns[0] !== 'SKU ID') {
                    results.push({
                        sku_id: columns[0],         
                        barcode: columns[1],        
                        product_name: columns[2],   
                        temperature: columns[3],    
                        // 전체 데이터를 담아 n8n에서 확인 가능하도록 평탄화된 배열을 포함합니다.
                        // 이를 통해 n8n 내부에서 재고 수량이 몇 번째 칸에 있는지 쉽게 파악할 수 있습니다.
                        raw_data: columns
                    });
                }
            });
            return results;
        });

        console.log(`📍 [STEP 9] 총 ${inventoryData.length}개의 데이터 추출 완료. n8n으로 반환합니다.`);

        // n8n이 바로 Item으로 분리(Split)할 수 있도록, 불필요한 래핑이나 raw 구조 없이 
        // 완벽히 평탄화된 순수 배열(Flat Array) 형태로만 응답합니다.
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
// Railway 환경에서 외부 접속(포트 포워딩)을 허용하기 위해 '0.0.0.0'을 명시합니다.
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Playwright server listening on :${PORT}`);
});
