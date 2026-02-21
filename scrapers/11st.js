const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const fs = require('fs');
const XLSX = require('xlsx'); // 엑셀 읽기 부품

const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];
const NAVER_USER = process.env['EMAIL_USER'];
const NAVER_PW = process.env['EMAIL_PW'];

let globalBrowser = null;
let globalPage = null;
let globalOtpRequestTime = 0; 

// (getAuthCodeFromMail 함수는 기존과 동일하여 생략합니다)

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            // (기존 로그인 로직 동일)
        }

        if (action === 'verify_auto') {
            // (기존 인증 로직 동일)
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '로그인 필요' });
            
            console.log('📍 [11st] 재고 페이지 진입...');
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(8000); 

            let targetFrame = null;
            for (const frame of globalPage.frames()) {
                if (await frame.locator('#btnSearch').count() > 0) {
                    targetFrame = frame;
                    break;
                }
            }
            if (!targetFrame) throw new Error('프레임을 찾지 못했습니다.');

            // 1. 검색 버튼 클릭
            await targetFrame.click('#btnSearch');
            await globalPage.waitForTimeout(5000);

            // 2. 🌟 엑셀 다운로드 버튼 클릭 및 파일 받기
            console.log('📍 [11st] 엑셀 다운로드 시작...');
            const [download] = await Promise.all([
                globalPage.waitForEvent('download'), // 다운로드 이벤트 대기
                targetFrame.click('button:has-text("엑셀다운로드")') // 버튼 클릭
            ]);

            const filePath = `./${download.suggestedFilename()}`;
            await download.saveAs(filePath); // 서버에 임시 저장

            // 3. 🌟 다운로드된 엑셀 파일 읽기 (36개 컬럼 전체)
            console.log('📍 [11st] 엑셀 파일 분석 중...');
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            
            // 엑셀 데이터를 JSON 배열로 변환
            const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 }); 
            
            // 헤더(1행) 제외하고 데이터만 정리 (col_0, col_1... 형태로 매핑)
            const finalData = rawData.slice(1).map(row => {
                const obj = {};
                row.forEach((cell, idx) => {
                    let val = cell === undefined || cell === null ? "" : String(cell).trim();
                    // 숫자 데이터에서 콤마 제거
                    if ([10, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23, 31].includes(idx)) {
                        val = val.replace(/,/g, '') || '0';
                    }
                    obj[`col_${idx}`] = val;
                });
                return obj;
            });

            // 임시 파일 삭제
            fs.unlinkSync(filePath);

            console.log(`📍 [11st] 엑셀 수집 성공: 총 ${finalData.length}건`);
            return res.json({ 
                status: 'SUCCESS', 
                count: finalData.length, 
                data: finalData 
            });
        }
    } catch (err) {
        console.error('📍 [11st] 에러:', err);
        return res.json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
