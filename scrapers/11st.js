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
        console.error('📍 [11st] 메일 에러:', err);
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
            let contextOptions = { viewport: { width: 1400, height: 1000 } };
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
            await globalPage.waitForTimeout(6000); 
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS' });
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '로그인 필요' });
            
            console.log('📍 [11st] 재고 페이지 진입 중...');
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', { waitUntil: 'networkidle', timeout: 60000 });
            await globalPage.waitForTimeout(10000); 

            let targetFrame = null;
            // 11번가 프레임을 더 정확하게 찾기 위해 모든 프레임을 뒤집니다.
            for (const frame of globalPage.frames()) {
                const searchBtnCount = await frame.locator('#btnSearch').count().catch(() => 0);
                if (searchBtnCount > 0) {
                    targetFrame = frame;
                    break;
                }
            }
            
            if (!targetFrame) throw new Error('재고 관리 버튼이 포함된 프레임을 찾을 수 없습니다.');

            console.log('📍 [11st] 검색 버튼 클릭 시도...');
            await targetFrame.click('#btnSearch', { force: true });
            
            // 데이터가 로딩되어 화면에 나타날 때까지 대기
            console.log('📍 [11st] 데이터 로딩 대기...');
            await targetFrame.waitForSelector('div[role="row"]', { timeout: 20000 }).catch(() => {});
            await globalPage.waitForTimeout(5000);

            const finalData = await targetFrame.evaluate(async () => {
                const results = new Map();
                const scrollContainer = document.querySelector('.jqx-grid-content') || document.querySelector('#contentSKUListGrid');
                if (!scrollContainer) return [];

                let lastScrollTop = -1;
                for (let i = 0; i < 30; i++) {
                    const rows = document.querySelectorAll('div[role="row"]');
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('div[role="gridcell"]');
                        if (cells.length > 5) { // 컬럼이 충분히 있는지 확인
                            // 엑셀 기준 col_2(SKU번호)를 고유 키로 사용
                            const skuId = (cells[2].textContent || '').trim();
                            if (skuId && skuId !== "" && !skuId.includes('수정')) {
                                const rowObj = {};
                                cells.forEach((cell, idx) => {
                                    let val = (cell.textContent || '').trim();
                                    // 숫자 컬럼 콤마 제거
                                    if ([12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25, 33].includes(idx)) {
                                        val = val.replace(/,/g, '') || '0';
                                    }
                                    rowObj[`col_${idx}`] = val;
                                });
                                results.set(skuId, rowObj);
                            }
                        }
                    });

                    if (scrollContainer.scrollTop === lastScrollTop) break;
                    lastScrollTop = scrollContainer.scrollTop;
                    scrollContainer.scrollTop += 600;
                    await new Promise(r => setTimeout(r, 1500));
                }
                return Array.from(results.values());
            });

            console.log(`📍 [11st] 수집 종료: ${finalData.length}건`);
            return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });
        }
    } catch (err) {
        console.error('📍 [11st] 스크랩 에러:', err);
        return res.json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
