const { chromium } = require('playwright');
const fs = require('fs');
const XLSX = require('xlsx'); // 🌟 엑셀 파싱 라이브러리 추가

const EZ_DOMAIN = process.env['EZ_DOMAIN'];
const EZ_USER = process.env['EZ_USER'];
const EZ_PW = process.env['EZ_PW'];

let globalBrowser = null;
let globalPage = null;

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('\n📍 [EZADMIN LOGIN] STEP 1: 브라우저 실행 및 세션 체크...');
            if (globalBrowser) await globalBrowser.close();
            
            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await globalBrowser.newContext({ viewport: { width: 1400, height: 900 } });
            globalPage = await context.newPage();

            console.log('📍 [EZADMIN LOGIN] STEP 2: 메인 페이지 접속...');
            await globalPage.goto('https://ezadmin.co.kr/index.html');
            await globalPage.click('li.login a');
            await globalPage.waitForTimeout(2000);

            console.log(`📍 [EZADMIN LOGIN] STEP 3: 정보 입력 (도메인: ${EZ_DOMAIN}, ID: ${EZ_USER})...`);
            await globalPage.fill('#login-domain', EZ_DOMAIN);
            await globalPage.fill('#login-id', EZ_USER);
            await globalPage.fill('#login-pwd', EZ_PW);

            console.log('📍 [EZADMIN LOGIN] STEP 4: 로그인 버튼 클릭...');
            await globalPage.click('input.login-btn');

            console.log('📍 [EZADMIN LOGIN] STEP 5: 보안코드 발생 여부 모니터링 중 (최대 4초 대기)...');
            try {
                const captchaInput = await globalPage.waitForSelector('input[id^="inputAuthCode"]', { timeout: 4000 });
                if (captchaInput) {
                    console.log('📍 [EZADMIN LOGIN] ✨ 보안코드 감지됨! 스크린샷 캡처 중...');
                    const captchaWrap = await globalPage.$('div[id^="auth_img_wrap"]');
                    const buffer = await captchaWrap.screenshot();
                    return res.json({
                        status: 'AUTH_REQUIRED',
                        screenshot: 'data:image/png;base64,' + buffer.toString('base64')
                    });
                }
            } catch (e) {
                console.log('📍 [EZADMIN LOGIN] ✅ 보안코드 없이 로그인 성공');
                return res.json({ status: 'SUCCESS', message: '로그인 완료' });
            }
        }

        if (action === 'verify_captcha') {
            const { captchaCode } = req.body;
            console.log(`\n📍 [EZADMIN VERIFY] STEP 1: 입력받은 보안코드 [${captchaCode}] 대입...`);
            await globalPage.fill('input[id^="inputAuthCode"]', captchaCode);
            
            console.log('📍 [EZADMIN VERIFY] STEP 2: 입력 완료 버튼 클릭...');
            await globalPage.click('button[id^="authcode_button"]');
            await globalPage.waitForTimeout(4000);

            console.log('📍 [EZADMIN VERIFY] STEP 3: 최종 세션 저장 중...');
            await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
            return res.json({ status: 'SUCCESS', message: '인증 완료' });
        }

        if (action === 'scrape') {
            console.log('\n📍 [EZADMIN SCRAPE] STEP 1: 재고 현황 페이지 이동...');
            if (!globalPage) throw new Error('세션이 없습니다. 로그인을 먼저 실행하세요.');
            
            await globalPage.goto('https://ga67.ezadmin.co.kr/template35.htm?template=I100', { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(3000);
            
            console.log('📍 [EZADMIN SCRAPE] STEP 2: 검색 버튼(F2) 클릭...');
            await globalPage.click('#search');
            await globalPage.waitForTimeout(5000); // 검색 결과 로딩 대기

            console.log('📍 [EZADMIN SCRAPE] STEP 3: 엑셀 다운로드 버튼 탐색 및 클릭 준비...');
            // 🌟 이지어드민의 엑셀 버튼 텍스트나 클래스명에 맞춰 수정이 필요할 수 있습니다.
            // 일반적으로 "엑셀", "Excel", "다운로드" 등의 텍스트가 포함된 버튼을 찾습니다.
            const downloadBtn = globalPage.locator('text="엑셀"').first(); 
            
            console.log('📍 [EZADMIN SCRAPE] STEP 4: 다운로드 이벤트 대기 중 (최대 60초)...');
            try {
                const [download] = await Promise.all([
                    globalPage.waitForEvent('download', { timeout: 60000 }),
                    downloadBtn.click({ force: true })
                ]);

                const filePath = `./temp_ezadmin_${Date.now()}.xlsx`;
                console.log(`📍 [EZADMIN SCRAPE] STEP 5: 파일을 임시 경로에 저장합니다 (${filePath})...`);
                await download.saveAs(filePath);

                console.log('📍 [EZADMIN SCRAPE] STEP 6: 엑셀 데이터 파싱 시작...');
                const workbook = XLSX.readFile(filePath);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                
                // header: 1 옵션을 주면 2차원 배열 형태로 데이터를 가져옵니다.
                const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                
                // 첫 번째 행(헤더)을 제외하고 데이터 매핑
                const finalData = rawData.slice(1).map((row) => {
                    const obj = {};
                    row.forEach((val, index) => {
                        obj[`col_${index}`] = (val === undefined || val === null) ? "" : String(val).trim();
                    });
                    return obj;
                });

                console.log('📍 [EZADMIN SCRAPE] STEP 7: 임시 파일 삭제 및 정리...');
                fs.unlinkSync(filePath);

                console.log(`📍 [EZADMIN SCRAPE] STEP 8: 성공! 총 ${finalData.length}개의 재고 데이터 추출 완료.`);
                return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });

            } catch (err) {
                console.error('📍 [EZADMIN SCRAPE] 다운로드 또는 파싱 실패:', err.message);
                const errorImg = await globalPage.screenshot();
                return res.json({ 
                    status: 'ERROR', 
                    message: `다운로드 실패: ${err.message}`, 
                    screenshot: 'data:image/png;base64,' + errorImg.toString('base64') 
                });
            }
        }
        
        return res.status(400).json({ status: 'ERROR', message: '정의되지 않은 액션입니다.' });

    } catch (err) {
        console.error('❌ [EZADMIN FATAL ERROR]', err.message);
        res.status(500).json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
