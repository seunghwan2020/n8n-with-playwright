const { chromium } = require('playwright');
const fs = require('fs');

// 🌟 이지어드민 전용 환경변수
const EZ_USER = process.env['EZ_USER'];
const EZ_PW = process.env['EZ_PW'];

// 이지어드민 전용 브라우저/페이지 상태 유지
let globalBrowser = null;
let globalPage = null;

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('📍 [EZADMIN LOGIN 1] 접속 준비...');
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            
            let contextOptions = { viewport: { width: 1280, height: 800 } };
            // 11번가와 섞이지 않도록 파일명 분리
            if (fs.existsSync('auth_ezadmin.json')) {
                console.log('📍 [EZADMIN LOGIN 2] 저장된 세션 발견! 장착합니다.');
                contextOptions.storageState = 'auth_ezadmin.json';
            }

            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();
            globalPage.on('dialog', async dialog => await dialog.accept());

            // 🌟 1. 이지어드민 실제 로그인 URL로 변경 필요
            await globalPage.goto('https://www.ezadmin.co.kr/login.html'); 
            await globalPage.waitForTimeout(4000);

            // 🌟 2. 로그인 완료 후 넘어가는 메인 URL 또는 로그아웃 버튼 기준으로 판별 수정 필요
            if (globalPage.url().includes('main.html')) {
                console.log('📍 [EZADMIN LOGIN 3] 세션 유지 확인! 프리패스합니다.');
                return res.json({ status: 'SUCCESS', message: '자동 로그인 되었습니다' });
            }

            console.log('📍 [EZADMIN LOGIN 4] 아이디/비밀번호 입력...');
            // 🌟 3. 이지어드민 입력창의 ID나 Name 속성에 맞게 선택자 변경 필요
            await globalPage.fill('input[name="user_id"]', EZ_USER);
            await globalPage.fill('input[name="user_pw"]', EZ_PW);
            await globalPage.click('button.btn_login'); // 로그인 버튼
            await globalPage.waitForTimeout(4000);

            // 세션 저장
            await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
            return res.json({ status: 'SUCCESS', message: '이지어드민 로그인 성공 (세션 저장)' });
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '로그인이 필요합니다.' });

            console.log('\n📍 [EZADMIN SCRAPE 1] 재고 페이지로 이동합니다...');
            // 🌟 4. 실제 재고조회 메뉴 URL로 변경 필요
            await globalPage.goto('https://www.ezadmin.co.kr/stock_list.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await globalPage.waitForTimeout(5000);

            console.log('📍 [EZADMIN SCRAPE 2] 검색 버튼 클릭!');
            // 🌟 5. 검색 버튼 선택자로 변경 필요
            await globalPage.click('#btnSearch'); 
            await globalPage.waitForTimeout(6000); // 표가 그려질 시간 대기

            console.log('📍 [EZADMIN SCRAPE 3] 데이터 긁어오기');
            const gridData = await globalPage.evaluate(() => {
                // 🌟 6. 이지어드민 테이블 구조에 맞게 수정 필요
                const rows = document.querySelectorAll('table tbody tr'); 
                const result = [];
                
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length > 0) {
                        const rowObj = {};
                        cells.forEach((cell, idx) => {
                            rowObj[`col_${idx}`] = (cell.textContent || '').trim();
                        });
                        // 데이터가 있는 행만 추가
                        if (Object.values(rowObj).join('').length > 5) {
                            result.push(rowObj);
                        }
                    }
                });
                return result;
            });

            if (gridData.length === 0) {
                console.log('📍 [경고] 데이터가 0건입니다. 스크린샷 캡처.');
                const imageBuffer = await globalPage.screenshot();
                return res.json({ 
                    status: 'CHECK_REQUIRED', 
                    message: '데이터 0건. 화면을 확인하세요.',
                    count: 0, data: [],
                    screenshot: 'data:image/png;base64,' + imageBuffer.toString('base64')
                });
            }

            console.log(`📍 [EZADMIN SCRAPE 완료] 총 ${gridData.length}개 추출!`);
            return res.json({ status: 'SUCCESS', count: gridData.length, data: gridData });
        }

        return res.status(400).json({ status: 'ERROR', message: `알 수 없는 action 입니다: ${action}` });

    } catch (error) {
        console.error(`📍 [EZADMIN 에러]`, error);
        // 에러 발생 시 현재 화면을 찍어서 보내줌
        if (globalPage) {
            const imageBuffer = await globalPage.screenshot();
            return res.json({ status: 'ERROR', message: error.message, screenshot: 'data:image/png;base64,' + imageBuffer.toString('base64') });
        }
        return res.status(500).json({ status: 'ERROR', message: error.message });
    }
}

// 이 모듈을 밖에서 쓸 수 있게 내보냄
module.exports = { execute };
