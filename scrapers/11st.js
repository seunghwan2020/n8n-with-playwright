const { chromium } = require('playwright');
const fs = require('fs');
const XLSX = require('xlsx');

// 11번가 셀러오피스 환경변수
const ELEVEN_ID = process.env['ELEVEN_ID'];
const ELEVEN_PW = process.env['ELEVEN_PW'];
const SESSION_FILE = 'auth_11st.json'; // 🌟 핵심: 물리적 세션 파일 경로

async function execute(action, req, res) {
    let browser = null; // 매번 새롭게 브라우저를 열고 닫아 메모리 누수를 방지합니다.

    try {
        if (action === 'login') {
            console.log('\n📍 [11ST LOGIN] STEP 1: 브라우저 실행 중...');
            browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
            const page = await context.newPage();

            console.log('📍 [11ST LOGIN] STEP 2: 11번가 셀러오피스 접속...');
            await page.goto('https://soffice.11st.co.kr/login/Login.tmall');
            await page.waitForTimeout(2000);

            console.log(`📍 [11ST LOGIN] STEP 3: 아이디(${ELEVEN_ID}) 및 비밀번호 입력...`);
            await page.fill('input[name="loginName"]', ELEVEN_ID);
            await page.fill('input[name="passWord"]', ELEVEN_PW);

            console.log('📍 [11ST LOGIN] STEP 4: 로그인 버튼 클릭...');
            await page.click('a.btn_login');
            
            console.log('📍 [11ST LOGIN] STEP 5: 로그인 결과 처리 대기 (5초)...');
            await page.waitForTimeout(5000); 

            console.log(`📍 [11ST LOGIN] STEP 6: 🌟 성공! 발급된 세션(쿠키)을 파일(${SESSION_FILE})로 저장합니다...`);
            await context.storageState({ path: SESSION_FILE });

            await browser.close();
            return res.json({ status: 'SUCCESS', message: '11번가 로그인 및 세션 파일 저장 완료' });
        }

        if (action === 'scrape') {
            console.log(`\n📍 [11ST SCRAPE] STEP 1: 세션 파일(${SESSION_FILE}) 존재 여부 확인...`);
            if (!fs.existsSync(SESSION_FILE)) {
                throw new Error(`세션 파일이 없습니다! n8n에서 먼저 /execute (action: login) 노드를 실행해 주세요.`);
            }

            console.log('📍 [11ST SCRAPE] STEP 2: 저장된 세션 파일을 입혀서 브라우저 실행...');
            browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await browser.newContext({ 
                storageState: SESSION_FILE, // 🌟 저장해둔 로그인 상태 그대로 주입
                viewport: { width: 1400, height: 900 }
            });
            const page = await context.newPage();

            console.log('📍 [11ST SCRAPE] STEP 3: 상품조회/수정(재고) 페이지로 다이렉트 이동...');
            await page.goto('https://soffice.11st.co.kr/view/product/stat', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);

            console.log('📍 [11ST SCRAPE] STEP 4: 엑셀다운로드 버튼 클릭...');
            const downloadBtn = page.locator('button:has-text("엑셀다운로드")').first(); 
            
            console.log('📍 [11ST SCRAPE] STEP 5: 파일 다운로드 대기 중 (최대 60초)...');
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 60000 }),
                downloadBtn.click({ force: true })
            ]);

            const filePath = `./temp_11st_${Date.now()}.xlsx`;
            console.log(`📍 [11ST SCRAPE] STEP 6: 임시 파일 저장 완료 (${filePath}). 엑셀 파싱 시작...`);
            await download.saveAs(filePath);

            const workbook = XLSX.readFile(filePath);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            
            const finalData = rawData.slice(1).map((row) => {
                const obj = {};
                row.forEach((val, index) => {
                    obj[`col_${index}`] = (val === undefined || val === null) ? "" : String(val).trim();
                });
                return obj;
            });

            console.log('📍 [11ST SCRAPE] STEP 7: 사용 완료된 임시 파일 삭제...');
            fs.unlinkSync(filePath);

            console.log(`📍 [11ST SCRAPE] STEP 8: ✅ 성공! 총 ${finalData.length}개의 데이터 추출 후 브라우저 종료.`);
            await browser.close();
            return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });
        }
        
        return res.status(400).json({ status: 'ERROR', message: '잘못된 액션입니다.' });

    } catch (err) {
        console.error('❌ [11ST FATAL ERROR]', err.message);
        if (browser) await browser.close(); // 에러 나도 좀비 브라우저 안 남게 확실히 닫기
        res.status(500).json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
