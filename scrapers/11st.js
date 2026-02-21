const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const fs = require('fs');
const XLSX = require('xlsx');

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
        console.error('DEBUG: [MAIL_ERROR]', err);
    } finally {
        lock.release();
        await client.logout();
    }
    return authCode;
}

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('STEP 1: Starting Login process...');
            if (globalBrowser) await globalBrowser.close();
            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            let contextOptions = { viewport: { width: 1280, height: 1000 } };
            if (fs.existsSync('auth.json')) {
                console.log('STEP 2: Found existing auth.json. Loading session...');
                contextOptions.storageState = 'auth.json';
            }
            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();
            globalPage.on('dialog', async dialog => await dialog.accept());

            console.log('STEP 3: Navigating to login page...');
            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            await globalPage.waitForTimeout(4000);

            if (globalPage.url().includes('soffice.11st.co.kr')) {
                console.log('STEP 4: Session valid. Auto-login successful.');
                return res.json({ status: 'SUCCESS', message: '자동 로그인 되었습니다' });
            }

            console.log('STEP 5: Inputting credentials...');
            await globalPage.fill('#loginName', USER_ID);
            await globalPage.fill('#passWord', USER_PW);
            await globalPage.click('button.c-button--submit');
            await globalPage.waitForTimeout(4000);

            if (await globalPage.isVisible('button:has-text("인증정보 선택하기")')) {
                console.log('STEP 6: Selecting authentication type...');
                await globalPage.click('button:has-text("인증정보 선택하기")');
                await globalPage.waitForTimeout(2000);
            }

            if (await globalPage.isVisible('label[for="auth_type_02"]')) {
                console.log('STEP 7: 2FA Required. Sending email verification...');
                await globalPage.click('label[for="auth_type_02"]');
                globalOtpRequestTime = Date.now() - 60000;
                await globalPage.click('button:has-text("인증번호 전송"):visible');
                return res.json({ status: 'AUTH_REQUIRED', message: '인증 메일 발송 완료' });
            }

            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS' });
        }

        if (action === 'verify_auto') {
            console.log('STEP 1: Starting OTP verification...');
            const code = await getAuthCodeFromMail();
            if (!code) {
                console.log('STEP 2: OTP mail not found yet. Waiting...');
                return res.json({ status: 'WAIT' });
            }
            console.log(`STEP 3: OTP received: ${code}. Filling input...`);
            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000);
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS' });
        }

        if (action === 'scrape') {
            console.log('STEP 1: Starting scrape action...');
            if (!globalPage) throw new Error('Global page is not initialized. Please login first.');

            console.log('STEP 2: Navigating to stock management page...');
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(8000);

            let targetFrame = null;
            console.log('STEP 3: Finding iframe for stock grid...');
            for (const frame of globalPage.frames()) {
                if (await frame.locator('#btnSearch').count() > 0) {
                    targetFrame = frame;
                    break;
                }
            }
            if (!targetFrame) throw new Error('Failed to find stock management frame.');

            console.log('STEP 4: Clicking search button...');
            await targetFrame.click('#btnSearch');
            await globalPage.waitForTimeout(5000);

            console.log('STEP 5: Triggering Excel download...');
            const downloadPromise = globalPage.waitForEvent('download');
            await targetFrame.click('button:has-text("엑셀다운로드")');
            const download = await downloadPromise;

            const filePath = `./temp_stock_list.xls`;
            console.log(`STEP 6: Saving download to ${filePath}...`);
            await download.saveAs(filePath);

            console.log('STEP 7: Reading Excel file with XLSX library...');
            const workbook = XLSX.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            console.log('STEP 8: Mapping columns for 36 items...');
            const finalData = rawData.slice(1).map((row) => {
                const obj = {};
                // 36개 컬럼 매핑 (SKU번호 ~ 최종수정자)
                for (let i = 0; i < 36; i++) {
                    let val = (row[i] === undefined || row[i] === null) ? "" : String(row[i]).trim();
                    // 숫자 콤마 제거 처리
                    if ([0, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 30].includes(i)) {
                        val = val.replace(/,/g, '') || '0';
                    }
                    obj[`col_${i}`] = val;
                }
                return obj;
            });

            console.log(`STEP 9: Cleanup - deleting temp file. Total items: ${finalData.length}`);
            fs.unlinkSync(filePath);

            return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });
        }
    } catch (err) {
        console.error('FATAL ERROR DURING EXECUTION:', err.message);
        return res.json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
