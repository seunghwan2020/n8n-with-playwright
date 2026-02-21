const { chromium } = require('playwright');
const fs = require('fs');

const EZ_DOMAIN = process.env['EZ_DOMAIN'];
const EZ_USER = process.env['EZ_USER'];
const EZ_PW = process.env['EZ_PW'];

let globalBrowser = null;
let globalPage = null;

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('📍 [EZADMIN] 로그인 시퀀스 시작...');
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ args: ['--no-sandbox'] });
            const context = await globalBrowser.newContext({ viewport: { width: 1400, height: 900 } });
            globalPage = await context.newPage();

            // 1. 메인 이동 후 로그인 팝업 띄우기
            await globalPage.goto('https://ezadmin.co.kr/index.html');
            await globalPage.click('li.login a'); // 첫 번째 이미지: 로그인 버튼 클릭
            await globalPage.waitForTimeout(2000);

            // 2. 도메인, 아이디, 비번 입력 (이미지 2, 3, 4 분석 반영)
            await globalPage.fill('#login-domain', EZ_DOMAIN);
            await globalPage.fill('#login-id', EZ_USER);
            await globalPage.fill('#login-pwd', EZ_PW);

            // 3. 로그인 버튼 클릭 (이미지 5)
            await globalPage.click('.login-btn');
            await globalPage.waitForTimeout(3000);

            // 4. 보안코드 입력창 확인 (이미지 6)
            const isCaptchaVisible = await globalPage.isVisible('input[id^="inputAuthCode"]');
            if (isCaptchaVisible) {
                console.log('📍 [EZADMIN] 보안코드 발견! 스크린샷을 전송합니다.');
                const captchaImage = await globalPage.screenshot();
                return res.json({
                    status: 'AUTH_REQUIRED',
                    message: '보안코드를 입력해주세요.',
                    screenshot: 'data:image/png;base64,' + captchaImage.toString('base64')
                });
            }

            return res.json({ status: 'SUCCESS', message: '로그인 성공' });
        }

        if (action === 'verify_captcha') {
            const { captchaCode } = req.body;
            console.log(`📍 [EZADMIN] 보안코드 [${captchaCode}] 입력 중...`);

            // 이미지 6, 7 분석 반영: 보안코드 입력 및 완료 버튼 클릭
            await globalPage.fill('input[id^="inputAuthCode"]', captchaCode);
            await globalPage.click('button[id^="authcode_button"]'); 
            await globalPage.waitForTimeout(4000);

            await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
            return res.json({ status: 'SUCCESS', message: '보안코드 인증 및 로그인 완료' });
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '세션이 없습니다.' });

            console.log('📍 [EZADMIN] 재고 페이지 이동 및 검색...');
            await globalPage.goto('https://ga67.ezadmin.co.kr/template35.htm?template=I100');
            await globalPage.waitForTimeout(3000);

            // 이미지 8: 검색 버튼 클릭 (id="search")
            await globalPage.click('#search');
            await globalPage.waitForTimeout(5000); // 데이터 로딩 대기

            // 이미지 9: jqxGrid 테이블 추출
            const stockData = await globalPage.evaluate(() => {
                const rows = document.querySelectorAll('#grid1 tbody tr[role="row"]');
                return Array.from(rows).map(row => {
                    const cells = row.querySelectorAll('td[role="gridcell"]');
                    const data = {};
                    cells.forEach(cell => {
                        const colName = cell.getAttribute('aria-describedby') || 'unknown';
                        data[colName] = cell.textContent.trim();
                    });
                    return data;
                });
            });

            return res.json({ status: 'SUCCESS', count: stockData.length, data: stockData });
        }

    } catch (error) {
        console.error('📍 [EZADMIN 에러]', error);
        res.status(500).json({ status: 'ERROR', message: error.message });
    }
}

module.exports = { execute };
