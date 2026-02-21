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

            // 검색 클릭
            await targetFrame.evaluate(() => document.querySelector('#btnSearch').click());
            await globalPage.waitForTimeout(5000); 

            // 🌟 자동 스크롤 수집 (중복 제거용 Map 사용)
            const finalData = await targetFrame.evaluate(async () => {
                const results = new Map();
                // 11번가 jqxGrid의 실제 스크롤 가능한 영역
                const scrollContainer = document.querySelector('.jqx-grid-content') || document.querySelector('#contentSKUListGrid');
                
                if (!scrollContainer) return [];

                let lastScrollTop = -1;
                for (let i = 0; i < 30; i++) { // 최대 30번 스크롤
                    const rows = document.querySelectorAll('div[role="row"]');
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('div[role="gridcell"]');
                        if (cells.length > 2) {
                            const skuNumber = (cells[2].textContent || '').trim();
                            if (skuNumber && skuNumber !== "") {
                                const rowObj = {};
                                cells.forEach((cell, idx) => {
                                    rowObj[`col_${idx}`] = (cell.textContent || '').trim();
                                });
                                results.set(skuNumber, rowObj); // SKU번호 기준 중복 제거
                            }
                        }
                    });

                    if (scrollContainer.scrollTop === lastScrollTop) break;
                    lastScrollTop = scrollContainer.scrollTop;
                    scrollContainer.scrollTop += 600; // 스크롤 내리기
                    await new Promise(r => setTimeout(r, 1200)); // 로딩 대기
                }
                return Array.from(results.values());
            });

            console.log(`📍 [11st] 수집 완료: ${finalData.length}건`);
            return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });
        }
    } catch (err) {
        return res.json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
