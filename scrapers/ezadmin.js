const { chromium } = require('playwright');
const fs = require('fs');

// 환경변수 로드
const EZ_DOMAIN = process.env['EZ_DOMAIN'];
const EZ_USER = process.env['EZ_USER'];
const EZ_PW = process.env['EZ_PW'];

let globalBrowser = null;
let globalPage = null;

/**
 * 이지어드민 전담 핸들러
 */
async function execute(action, req, res) {
    try {
        // 1. 로그인 단계 (ID/PW 입력 후 보안코드 스크린샷 반환)
        if (action === 'login') {
            console.log('📍 [EZADMIN] 로그인 프로세스 시작...');
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ 
                args: ['--no-sandbox', '--disable-setuid-sandbox'] 
            });
            
            const context = await globalBrowser.newContext({
                viewport: { width: 1400, height: 900 }
            });
            globalPage = await context.newPage();

            // 메인 페이지 접속 및 로그인 클릭 (이미지 1 반영)
            await globalPage.goto('https://ezadmin.co.kr/index.html');
            await globalPage.click('li.login a'); 
            await globalPage.waitForTimeout(2000);

            // 도메인/아이디/비번 입력 (이미지 2, 3, 4 반영)
            await globalPage.fill('#login-domain', EZ_DOMAIN);
            await globalPage.fill('#login-id', EZ_USER);
            await globalPage.fill('#login-pwd', EZ_PW);

            // 로그인 버튼 클릭 (이미지 5 반영)
            await globalPage.click('.login-btn');
            await globalPage.waitForTimeout(3000);

            // 보안코드(Captcha) 창이 떴는지 확인 (이미지 6 반영)
            const captchaInputSelector = 'input[id^="inputAuthCode"]';
            const isCaptchaVisible = await globalPage.isVisible(captchaInputSelector);

            if (isCaptchaVisible) {
                console.log('📍 [EZADMIN] 보안코드 발견! 스크린샷 캡처 중...');
                
                // AI 인식률을 높이기 위해 보안코드 영역만 정밀 캡처 (이미지 6의 auth_img_wrap 부분)
                const captchaElement = await globalPage.$('div[id^="auth_img_wrap"]');
                const captchaBuffer = await captchaElement.screenshot();

                return res.json({
                    status: 'AUTH_REQUIRED',
                    message: '보안코드가 필요합니다.',
                    screenshot: 'data:image/png;base64,' + captchaBuffer.toString('base64')
                });
            }

            return res.json({ status: 'SUCCESS', message: '로그인 성공' });
        }

        // 2. 보안코드 검증 단계 (AI 또는 사용자가 읽은 번호 입력)
        if (action === 'verify_captcha') {
            const { captchaCode } = req.body; // n8n에서 보낸 숫자 4자리
            if (!captchaCode) return res.status(400).json({ status: 'ERROR', message: 'captchaCode가 없습니다.' });

            console.log(`📍 [EZADMIN] 보안코드 [${captchaCode}] 입력 및 확인...`);
            
            // 보안코드 입력 및 완료 버튼 클릭 (이미지 6, 7 반영)
            await globalPage.fill('input[id^="inputAuthCode"]', captchaCode);
            await globalPage.click('button[id^="authcode_button"]');
            await globalPage.waitForTimeout(5000);

            // 세션 저장 (이지어드민 전용)
            await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
            return res.json({ status: 'SUCCESS', message: '보안코드 인증 성공 및 세션 저장 완료' });
        }

        // 3. 재고 데이터 추출 단계
        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '브라우저 세션이 없습니다. 로그인을 먼저 하세요.' });

            console.log('📍 [EZADMIN] 재고 현황 페이지로 이동...');
            // 요청하신 특정 URL로 이동
            const targetUrl = `https://ga67.ezadmin.co.kr/template35.htm?template=I100`;
            await globalPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(3000);

            // 검색 버튼 클릭 (이미지 8 반영)
            console.log('📍 [EZADMIN] 검색 버튼(F2) 클릭...');
            await globalPage.click('#search');
            
            // jqxGrid 로딩 대기 (데이터가 표에 나타날 때까지)
            await globalPage.waitForTimeout(7000);

            console.log('📍 [EZADMIN] jqxGrid 테이블 데이터 파싱 시작...');
            // 이미지 9의 테이블 구조 반영 (jqxGrid 전용 파싱)
            const stockData = await globalPage.evaluate(() => {
                const rows = document.querySelectorAll('#grid1 tbody tr[role="row"]');
                const results = [];

                rows.forEach(row => {
                    const cells = row.querySelectorAll('td[role="gridcell"]');
                    if (cells.length > 0) {
                        const rowData = {};
                        cells.forEach(cell => {
                            // aria-describedby 속성에서 컬럼명 추출 (grid1_product_name 등)
                            const colId = cell.getAttribute('aria-describedby');
                            if (colId) {
                                rowData[colId] = (cell.textContent || '').trim();
                            }
                        });
                        // 의미 있는 데이터가 있는 행만 추가
                        if (Object.keys(rowData).length > 0) {
                            results.push(rowData);
                        }
                    }
                });
                return results;
            });

            console.log(`📍 [EZADMIN] 총 ${stockData.length}건의 재고 데이터를 가져왔습니다.`);
            return res.json({
                status: 'SUCCESS',
                count: stockData.length,
                data: stockData
            });
        }

        return res.status(400).json({ status: 'ERROR', message: '정의되지 않은 액션입니다.' });

    } catch (error) {
        console.error('📍 [EZADMIN 핸들러 에러]', error);
        
        // 에러 시 현재 상태 스크린샷 찍어서 응답 (디버깅용)
        let screenshot = null;
        if (globalPage) {
            const buffer = await globalPage.screenshot();
            screenshot = 'data:image/png;base64,' + buffer.toString('base64');
        }

        res.status(500).json({ 
            status: 'ERROR', 
            message: error.message,
            screenshot: screenshot 
        });
    }
}

module.exports = { execute };
