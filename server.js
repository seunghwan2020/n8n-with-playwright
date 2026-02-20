const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const { Client } = require("pg");
const imaps = require("imap-simple");
const { simpleParser } = require("mailparser");

const app = express();
app.use(express.json({ limit: "5mb" }));

// ====== 필수 환경변수 ======
const PG_URL = process.env.PG_URL || process.env.DATABASE_URL;
const LOGIN_URL = process.env.LOGIN_URL;
const SELLER_ID = process.env.SELLER_ID;
const SELLER_PW = process.env.SELLER_PW;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PW = process.env.EMAIL_PW;

const STORAGE_STATE_PATH = "/data/storageState.json";
const DOWNLOAD_PATH = "/data/stock.xlsx";
const UPSERT_TABLE = process.env.UPSERT_TABLE || "n_delivery_stock";
const TARGET_PAGE_URL = "https://soffice.11st.co.kr/view/40394";

// ====== 유틸 함수 ======
function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function ensureTable(client) {
  const sql = `CREATE TABLE IF NOT EXISTS ${UPSERT_TABLE} (sku TEXT PRIMARY KEY, stock_qty INTEGER, updated_at TIMESTAMPTZ DEFAULT NOW());`;
  await client.query(sql);
}

async function upsertRowsToPostgres(rows) {
  if (!PG_URL) throw new Error("PG_URL 환경변수가 없습니다.");
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  await ensureTable(client);

  const stmt = `INSERT INTO ${UPSERT_TABLE} (sku, stock_qty, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (sku) DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = NOW();`;

  for (const r of rows) {
    const sku = String(r["판매자SKU"] || r["SKU"] || "").trim();
    const qty = Number(String(r["재고수량"] || r["재고"] || "0").replace(/,/g, ""));
    if (sku && Number.isFinite(qty)) await client.query(stmt, [sku, qty]);
  }
  await client.end();
}

// ====== [핵심 수정] 스마트 폴링: 메일이 오면 즉시 가져오기 ======
async function getAuthCodeWithRetry(maxAttempts = 10) {
  console.log(`메일함(${EMAIL_USER})에서 인증번호를 찾기 시작합니다...`);
  const config = {
    imap: {
      user: EMAIL_USER,
      password: EMAIL_PW,
      host: "imap.worksmobile.com",
      port: 993,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  for (let i = 1; i <= maxAttempts; i++) {
    console.log(`[메일 확인 ${i}/${maxAttempts}회차] 5초 후 다시 확인합니다...`);
    await new Promise(res => setTimeout(res, 5000)); // 5초 대기

    try {
      const connection = await imaps.connect(config);
      await connection.openBox("INBOX");
      const searchCriteria = ["UNSEEN"];
      const fetchOptions = { bodies: [""], markSeen: true };
      const messages = await connection.search(searchCriteria, fetchOptions);

      if (messages && messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        const part = lastMessage.parts.find(p => p.which === "");
        const mail = await simpleParser(part.body);
        const match = (mail.text || mail.html || "").match(/\b\d{6}\b/);
        connection.end();
        if (match) return match[0];
      }
      connection.end();
    } catch (err) {
      console.log("IMAP 접속 중 일시적 오류 발생, 다음 회차에 재시도합니다.");
    }
  }
  throw new Error("❌ 인증 메일을 끝내 찾지 못했습니다. 11번가 전송 여부를 확인하세요.");
}

// ====== 1. 로그인 및 2단계 인증 돌파 (최적화) ======
async function loginAndSaveStorageState() {
  console.log("로봇이 11번가 자동 로그인을 시작합니다...");
  ensureDir(STORAGE_STATE_PATH);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.fill('input[name="loginName"], input[name="id"]', SELLER_ID);
    await page.fill('input[name="passWord"], input[name="pw"]', SELLER_PW);
    await page.click('button:has-text("로그인")');

    if (await page.locator('text="로그인 2단계 인증"').isVisible({ timeout: 10000 })) {
      console.log("🔒 2단계 인증 화면 감지됨!");
      await page.locator('#nldList_0, tr:has-text("정*라")').first().click({ force: true });
      await page.click('button:has-text("인증정보 선택하기")');
      await page.waitForTimeout(2000);

      // 이메일 옵션 강제 선택
      await page.locator('label:has-text("이메일"), input[type="radio"]:near(:text("이메일"))').first().click({ force: true });
      page.once("dialog", async d => await d.accept());
      await page.locator('button:has-text("인증번호 전송"):visible').first().click();
      
      // [수정] 25초 대기 대신 스마트 폴링 실행
      const authCode = await getAuthCodeWithRetry();
      console.log(`✅ 가로챈 인증번호: ${authCode}`);

      await page.fill('input[type="text"]:visible, input[type="tel"]:visible', authCode);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click('button:has-text("확인")')
      ]);
    }
    await page.goto("https://soffice.11st.co.kr", { waitUntil: "domcontentloaded" });
    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await context.close();
    await browser.close();
  }
}

// ====== 2. UI 화면 엑셀 다운로드 ======
async function downloadExcelWithPlaywrightOnce() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(TARGET_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (page.url().includes("login")) throw new Error("HTML이 내려왔습니다 (세션 만료)");

    await page.click('button:has-text("검색")');
    await page.waitForTimeout(2000);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.click('button:has-text("엑셀다운로드")')
    ]);

    ensureDir(DOWNLOAD_PATH);
    await download.saveAs(DOWNLOAD_PATH);
    const wb = XLSX.readFile(DOWNLOAD_PATH);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    await upsertRowsToPostgres(rows);
    
    await context.close();
    await browser.close();
    return { ok: true, rowsCount: rows.length };
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

app.post("/run", async (req, res) => {
  try {
    if (!fs.existsSync(STORAGE_STATE_PATH)) await loginAndSaveStorageState();
    let result;
    try {
      result = await downloadExcelWithPlaywrightOnce();
    } catch (e) {
      if (String(e).includes("세션 만료")) {
        await loginAndSaveStorageState();
        result = await downloadExcelWithPlaywrightOnce();
      } else throw e;
    }
    res.json(result);
  } catch (e) {
    console.error("실행 중 에러 발생:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/healthz", (req, res) => res.status(200).send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Playwright server listening on :${PORT}`));
