const { chromium } = require('playwright');
const fs = require('fs');
const XLSX = require('xlsx');

// 11번가 셀러오피스 환경변수 (.env 파일에 설정 필요)
const ELEVEN_ID = process.env['ELEVEN_ID'];
const ELEVEN_PW = process.env['ELEVEN_PW'];

let globalBrowser = null;
let globalPage = null;

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('\n📍 [11ST LOGIN] STEP 1: 브라우저 실행 및 기존 세션 초기화...');
            if (globalBrowser) await globalBrowser.close();
            
            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const context = await globalBrowser.newContext({ viewport: { width: 1400, height: 900 } });
            globalPage = await context.newPage();

            console.log('📍 [11ST LOGIN] STEP 2: 11번가 셀러오피스 로그인 페이지 접속...');
            await globalPage.goto('https://soffice.11st.co.kr/login/Login.tmall');
            await globalPage.waitForTimeout(2000); // 페이지 로딩 대기

            console.log(`📍 [11ST LOGIN] STEP 3: 아이디(${ELEVEN_ID}) 및 비밀번호 입력...`);
            // 🌟 DOM 선택자는 11번가 셀러오피스 실제 HTML에 맞춰 수정이 필요할 수 있습니다.
            await globalPage.fill('input[name="loginName"]', ELEVEN_ID);
            await globalPage.fill('input[name="passWord"]', ELEVEN_PW);

            console.log('📍 [11ST LOGIN] STEP 4: 로그인 버튼 클릭...');
            await globalPage.click('a.btn_login'); // 로그인 버튼 클래스명
            
            console.log('📍 [11ST LOGIN] STEP 5: 로그인 결과 대기 및 화면 캡처 준비 (최대 5초)...');
            await globalPage.waitForTimeout(5000); 

            // 11번가는 2단계 인증이나 캡차가 뜰 수 있으므로, 해당 요소가 있는지 체크하는 로직 추가 권장
            console.log('📍 [11ST LOGIN] ✅ 로그인 완료 프로세스 통과');
            return res.json({ status: 'SUCCESS', message: '11번가 로그인 완료' });
        }

        if (action === 'scrape') {
            console.log('\n📍 [11ST SCRAPE] STEP 1: 세션 상태 확인...');
            if (!globalPage) throw new Error('세션이 없습니다. /execute (action: login)을 먼저 실행하세요.');
            
            console.log('📍 [11ST SCRAPE] STEP 2: 상품조회/수정 페이지로 이동...');
            // 🌟 실제 재고 엑셀 다운로드가 가능한 메뉴의 URL로 변경해 주세요.
            await globalPage.goto('https://soffice.11st.co.kr/view/product/stat', { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(3000);

            console.log('📍 [11ST SCRAPE] STEP 3: 엑셀 다운로드 버튼 탐색 및 클릭...');
            // 🌟 11번가의 '엑셀다운로드' 버튼 텍스트나 ID에 맞춰야 합니다.
            const downloadBtn = globalPage.locator('button:has-text("엑셀다운로드")').first(); 
            
            console.log('📍 [11ST SCRAPE] STEP 4: 파일 다운로드 이벤트 대기 중 (최대 60초)...');
            const [download] = await Promise.all([
                globalPage.waitForEvent('download', { timeout: 60000 }),
                downloadBtn.click({ force: true })
            ]);

            const filePath = `./temp_11st_${Date.now()}.xlsx`;
            console.log(`📍 [11ST SCRAPE] STEP 5: 파일을 임시 경로에 저장합니다 (${filePath})...`);
            await download.saveAs(filePath);

            console.log('📍 [11ST SCRAPE] STEP 6: 엑셀 데이터 파싱 및 JSON 변환 시작...');
            const workbook = XLSX.readFile(filePath);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            
            // 2차원 배열 형태로 가져오기 (n8n Split Out 노드 대응)
            const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            
            // 첫 번째 행(헤더)을 제외하고 col_0, col_1 형태로 매핑
            const finalData = rawData.slice(1).map((row) => {
                const obj = {};
                row.forEach((val, index) => {
                    obj[`col_${index}`] = (val === undefined || val === null) ? "" : String(val).trim();
                });
                return obj;
            });

            console.log('📍 [11ST SCRAPE] STEP 7: 사용 완료된 임시 엑셀 파일 삭제...');
            fs.unlinkSync(filePath);

            console.log(`📍 [11ST SCRAPE] STEP 8: ✅ 성공! 총 ${finalData.length}개의 캐리어 재고 데이터 추출 완료.`);
            return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });
        }
        
        return res.status(400).json({ status: 'ERROR', message: '정의되지 않은 액션입니다 (login 또는 scrape만 지원).' });

    } catch (err) {
        console.error('❌ [11ST FATAL ERROR] 실행 중 치명적 오류 발생:', err.message);
        // 에러 발생 시 어디서 멈췄는지 알기 위해 스크린샷 캡처
        if (globalPage) {
            const errorImg = await globalPage.screenshot();
            return res.status(500).json({ 
                status: 'ERROR', 
                message: err.message,
                screenshot: 'data:image/png;base64,' + errorImg.toString('base64')
            });
        }
        res.status(500).json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
