const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const fs = require('fs');

const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];
const NAVER_USER = process.env['EMAIL_USER'];
const NAVER_PW = process.env['EMAIL_PW'];

let globalBrowser = null;
let globalPage = null;
let globalOtpRequestTime = 0; 

async function getAuthCodeFromMail() {
    const client = new ImapFlow({
        host: 'imap.worksmobile.com',
        port: 993,
        secure: true,
        auth: { user: NAVER_USER, pass: NAVER_PW },
        logger: false
    });
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    let authCode = null;
    try {
        const searchList = await client.search({ unseen: true });
        if (searchList.length > 0) {
            const latestSeq = searchList[searchList.length - 1]; 
            const message = await client.fetchOne(latestSeq, { source: true });
            if (message && message.source) {
                const mail = await simpleParser(message.source);
                const mailDate = mail.date ? mail.date.getTime() : 0;
                if (mailDate < globalOtpRequestTime) return null; 
                await client.messageFlagsAdd(latestSeq, ['\\Seen']);
                const mailText = mail.text || mail.html;
                const match = mailText.match(/\d{6,8}/);
                if (match) authCode = match[0];
            }
        }
    } catch (err) {
        console.error('📍 [11번가 메일 에러]', err);
    } finally {
        lock.release();
        await client.logout();
    }
    return authCode;
}

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            if (globalBrowser) await globalBrowser.close();
            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            let contextOptions = { viewport: { width: 1280, height: 1000 } };
            if (fs.existsSync('auth.json')) {
                contextOptions.storageState = 'auth.json';
            }
            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();
            globalPage.on('dialog', async dialog => await dialog.accept());
            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            await globalPage.waitForTimeout(4000);
            if (globalPage.url().includes('soffice.11st.co.kr')) return res.json({ status: 'SUCCESS' });
            await globalPage.fill('#loginName', USER_ID);
            await globalPage.fill('#passWord', USER_PW);
            await globalPage.click('button.c-button--submit');
            await globalPage.waitForTimeout(4000);
            if (await globalPage.isVisible('button:has-text("인증정보 선택하기")')) {
                await globalPage.click('button:has-text("인증정보 선택하기")');
                await globalPage.waitForTimeout(2000);
            }
            if (await globalPage.isVisible('label[for="auth_type_02"]')) {
                await globalPage.click('label[for="auth_type_02"]'); 
                globalOtpRequestTime = Date.now() - 60000; 
                await globalPage.click('button:has-text("인증번호 전송"):visible'); 
                return res.json({ status: 'AUTH_REQUIRED' });
            }
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS' });
        }

        if (action === 'verify_auto') {
            const code = await getAuthCodeFromMail();
            if (!code) return res.json({ status: 'WAIT' });
            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000); 
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS' });
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '로그인 필요' });
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(8000); 

            let targetFrame = null;
            const frames = globalPage.frames();
            for (const frame of frames) {
                if (await frame.locator('#btnSearch').count() > 0) {
                    targetFrame = frame;
                    break;
                }
            }
            if (!targetFrame) throw new Error('프레임을 찾지 못했습니다.');

            // 🌟 300개씩 보기 설정 변경 (데이터 누락 방지)
            console.log('📍 [11st] 페이지당 건수를 300건으로 변경합니다.');
            try {
                // 하단 페이지당 건수 선택 셀렉트 박스 조작 (사이트 구조에 따라 ID나 class 확인 필요)
                // 보통 jqx-grid의 하단 콤보박스를 클릭하여 300 선택
                await targetFrame.evaluate(() => {
                    const pageSizeCombo = document.querySelector('.jqx-grid-pager-input');
                    if (pageSizeCombo) {
                        // 단순히 숫자를 바꾸는게 아니라 이벤트를 발생시키거나 
                        // 11번가 페이지 내 함수 호출 (예: $("#SKUListGrid").jqxGrid({ pagesize: 300 });)
                        // 안전하게 셀렉트 박스가 있다면 직접 선택 시도
                        const select = document.querySelector('select[role="listbox"]'); // 예시
                        if (select) {
                            select.value = "300";
                            select.dispatchEvent(new Event('change'));
                        }
                    }
                });
                await globalPage.waitForTimeout(2000);
            } catch (e) {
                console.log('📍 [주의] 300건 변경 실패, 기본값으로 진행합니다.');
            }

            // 검색 클릭
            await targetFrame.evaluate(() => document.querySelector('#btnSearch').click());
            await globalPage.waitForTimeout(10000); 

            // 데이터 추출
            const gridData = await targetFrame.evaluate(() => {
                const rows = document.querySelectorAll('div[role="row"]');
                const result = [];
                rows.forEach(row => {
                    const cells = row.querySelectorAll('div[role="gridcell"]');
                    if (cells.length > 2) {
                        let rowFullText = ''; 
                        const rowObj = {};
                        cells.forEach((cell, idx) => {
                            const text = (cell.textContent || '').replace(/\s+/g, ' ').trim(); 
                            rowObj[`col_${idx}`] = text;
                            rowFullText += text;
                        });
                        if (rowFullText.length > 5) result.push(rowObj);
                    }
                });
                return result;
            });

            console.log(`📍 [11st] 수집 완료: ${gridData.length}건`);
            // 🌟 screenshot_full 제거하여 응답을 가볍게 만듭니다.
            return res.json({ 
                status: 'SUCCESS', 
                count: gridData.length,
                data: gridData 
            });
        }
    } catch (err) {
        return res.json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
