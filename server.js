const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json());

const SESSION_FILE = '/data/naver_session.json'; // Railway Volume 마운트 경로 추천

app.post('/scrape/naver-inventory', async (req, res) => {
    const { id, pw } = req.body;
    let browser;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // 클라우드 환경 필수 옵션
        });

        // 세션(쿠키)이 있으면 불러오기, 없으면 새로 로그인
        let context;
        if (fs.existsSync(SESSION_FILE)) {
            context = await browser.newContext({ storageState: SESSION_FILE });
        } else {
            context = await browser.newContext();
        }

        const page = await context.newPage();

        // 1. 네이버 커머스 로그인 페이지 진입 (세션이 없을 때만)
        if (!fs.existsSync(SESSION_FILE)) {
            await page.goto('https://accounts.commerce.naver.com/login?url=https%3A%2F%2Fsell.smartstore.naver.com%2F%23%2Flogin-callback');
            
            // 봇 탐지 우회: evaluate로 직접 값 입력 (또는 clipboard 복붙 로직 사용)
            await page.evaluate(({naverId, naverPw}) => {
                document.querySelector('input[name="id"]').value = naverId;
                document.querySelector('input[name="pw"]').value = naverPw;
            }, { naverId: id, naverPw: pw });

            // 로그인 버튼 클릭
            await page.click('button[type="submit"]');
            
            // 로그인 완료 후 URL 변경이나 특정 요소 대기 (2단계 인증이 뜰 수 있음 - 주의)
            await page.waitForNavigation({ waitUntil: 'networkidle' });

            // 성공 시 세션 저장 (Railway Volume에 저장됨)
            await context.storageState({ path: SESSION_FILE });
        }

        // 2. N배송 재고관리 페이지 이동
        await page.goto('https://sell.smartstore.naver.com/#/logistics/sku-management/information');
        await page.waitForSelector('.css-v3t7n8'); // 검색 버튼 렌더링 대기

        // 3. 검색 버튼 클릭
        await page.click('button:has-text("검색")'); // '검색' 텍스트를 가진 버튼 클릭
        
        // 데이터 로딩 대기 (로더가 사라지거나 그리드 데이터가 뜰 때까지)
        await page.waitForTimeout(3000); // 명시적 대기(안정성 확보)

        // 4. 데이터 추출 (페이지네이션 생략된 단일 페이지 기준 예시)
        const inventoryData = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('div[role="row"]')); // 실제 그리드의 Row 셀렉터 확인 필요
            return rows.map(row => {
                const cells = row.querySelectorAll('div[role="gridcell"]');
                if (cells.length === 0) return null;
                return {
                    sku_id: cells[1]?.innerText || '', // 컬럼 인덱스는 실제 HTML 구조에 맞게 수정 필요
                    sku_name: cells[2]?.innerText || '',
                    barcode: cells[3]?.innerText || '',
                    stock: parseInt(cells[4]?.innerText || '0', 10)
                };
            }).filter(item => item !== null);
        });

        await browser.close();
        res.json({ success: true, data: inventoryData });

    } catch (error) {
        console.error('Scraping Error:', error);
        if (browser) await browser.close();
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(8080, () => {
    console.log('Playwright API Server running on port 8080');
});
