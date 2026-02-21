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
        
        // 캡처해주신 돔(DOM) 구조를 바탕으로 안정적인 셀렉터를 타겟팅합니다.
        // 1. ID 입력 (이메일/판매자 아이디) - 사람처럼 타이핑
        await page.type('input[placeholder="아이디 또는 이메일 주소"]', NAV_USER, { delay: 100 }); 
        
        // 2. 비밀번호 입력
        await page.type('input[placeholder="비밀번호"]', NAV_PW, { delay: 100 });
        
        // 3. 로그인 버튼 클릭 (내부 텍스트가 '로그인'인 버튼을 명시적으로 클릭)
        await page.click('button:has-text("로그인")');

        console.log('📍 [STEP 5] 로그인 버튼 클릭 완료! 2단계 인증 대기 중...');

        // 🔒 2단계 인증 화면 감지 및 처리
        try {
            // 인증 화면이 뜨는지 최대 5초간 대기
            await page.waitForSelector('text=인증정보 선택하기', { timeout: 5000 });
            console.log('🔒 2단계 인증 화면 감지됨!');
            
            // 이메일 옵션을 찾으며 헤매지 않고, 디폴트로 둔 상태에서 즉시 버튼을 명시적으로 클릭합니다.
            console.log('[인증정보 선택하기] 버튼 클릭!');
            await page.click('text=인증정보 선택하기');
            
        } catch (e) {
            console.log('2단계 인증 화면이 없거나 이미 통과했습니다.');
        }

        // 3. 재고 페이지 이동 및 데이터 크롤링 (이후 실제 데이터 파싱 시 작성할 영역)
        // await page.goto('N배송_재고관리_페이지_URL');
        // const rawData = await page.$$eval('table tr', rows => { ... });

        console.log('📍 [STEP 6] 데이터 정제 및 n8n 반환 완료');

        // 4. PostgreSQL 저장용 정제 데이터 (테스트용)
        const cleanedData = [
            { 
                sku_id: 'ITEM-BLK-20', 
                n_delivery_stock: 150, 
                sales_count: 12 
            },
            { 
                sku_id: 'ITEM-SLV-24', 
                n_delivery_stock: 85, 
                sales_count: 5 
            }
        ];

        // n8n이 바로 Item으로 인식하도록 배열 형태로 리턴
        res.status(200).json(cleanedData);

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
// Railway 환경에서 외부 접속 허용
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Playwright server listening on :${PORT}`);
});
