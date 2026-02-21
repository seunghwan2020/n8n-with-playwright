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
        console.log('Starting Container');
        console.log('로봇이 네이버 스마트스토어 자동 로그인을 시작합니다...');
        
        browser = await chromium.launch({ 
            headless: true, // Railway 환경에서는 반드시 true
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        const context = await browser.newContext();
        const page = await context.newPage();

        // 1. 로그인 페이지 이동
        await page.goto('https://sell.smartstore.naver.com/#/login', { waitUntil: 'networkidle' });

        // 로그인 정보 입력 (Railway 환경 변수 사용)
        // 주의: 네이버 로그인 폼의 실제 HTML 태그 id나 name에 맞춰 셀렉터를 수정해야 할 수 있습니다.
        await page.fill('#username_selector', NAV_USER); 
        await page.fill('#password_selector', NAV_PW);
        await page.click('#login_button_selector');

        // 2. 🔒 2단계 인증 화면 감지 및 처리
        try {
            // 인증 화면이 뜨는지 최대 5초간 대기
            await page.waitForSelector('text=인증정보 선택하기', { timeout: 5000 });
            console.log('🔒 2단계 인증 화면 감지됨!');
            
            // 옵션을 건드리지 않고 디폴트 상태에서 버튼만 명시적으로 클릭
            console.log('[인증정보 선택하기] 버튼 클릭!');
            await page.click('text=인증정보 선택하기');
            
            // 인증번호 입력 대기 등 추가 로직이 필요하다면 여기에 작성
            
        } catch (e) {
            console.log('2단계 인증 화면이 없거나 이미 통과했습니다.');
        }

        // 3. 재고 페이지 이동 및 데이터 크롤링 
        // await page.goto('N배송_재고관리_페이지_URL');
        // const rawData = await page.$$eval('table tr', rows => { ... });

        // 4. PostgreSQL 저장용 정제 데이터 
        // D.CURVIN 여행용 캐리어 라인업에 맞춘 테스트 데이터 예시입니다.
        // 불필요한 객체 래핑 없이 바로 배열로 구성합니다.
        const cleanedData = [
            { 
                sku_id: 'DCURVIN-BLK-20', 
                n_delivery_stock: 150, 
                sales_count: 12 
            },
            { 
                sku_id: 'DCURVIN-SLV-24', 
                n_delivery_stock: 85, 
                sales_count: 5 
            }
        ];

        // n8n에서 쓸데없는 구조 없이 바로 Item으로 쓸 수 있도록 배열 자체를 리턴합니다.
        // n8n의 HTTP Request 노드 설정에서 'Response Format'을 'JSON'으로 두면 깔끔하게 파싱됩니다.
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
app.listen(PORT, () => {
    console.log(`Playwright server listening on :${PORT}`);
});
