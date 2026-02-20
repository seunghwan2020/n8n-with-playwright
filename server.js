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

const COL_SKU_CANDIDATES = ["SKU", "sku", "상품SKU", "SellerSKU", "판매자SKU", "옵션SKU"];
const COL_QTY_CANDIDATES = ["재고", "재고수량", "수량", "재고수", "Stock", "stock_qty"];

// ====== 유틸 함수 ======
function pickCol(row, candidates) {
  for (const c of candidates) {
    if (row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== "") return c;
  }
  return null;
}

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function ensureTable(client) {
  const sql = `
    CREATE TABLE IF NOT EXISTS ${UPSERT_TABLE} (
      sku TEXT PRIMARY KEY,
      stock_qty INTEGER,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  await client.query(sql);
}

async function upsertRowsToPostgres(rows) {
  if (!PG_URL) throw new Error("PG_URL 환경변수가 없습니다.");
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  await ensureTable(client);

  let inserted = 0, skipped = 0;
  const firstRow = rows.find(r => r && typeof r === "object");
  if (!firstRow) return { inserted: 0, skipped: rows.length };

  const skuCol = pickCol(firstRow, COL_SKU_CANDIDATES);
  const qtyCol = pickCol(firstRow, COL_QTY_CANDIDATES);
  if (!skuCol || !qtyCol) throw new Error("엑셀 컬럼을 못 찾았습니다.");

  const stmt = `
    INSERT INTO ${UPSERT_TABLE} (sku, stock_qty, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (sku) DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = NOW();
  `;

  for (const r of rows) {
    if (!r || typeof r !== "object") { skipped++; continue; }
    const sku = String(r[skuCol] ?? "").trim();
    if (!sku) { skipped++; continue; }
    const qty = Number(String(r[qtyCol]).replace(/,/g, "").trim());
    if (!Number.isFinite(qty)) { skipped++; continue; }

    await client.query(stmt, [sku, qty]);
    inserted++;
  }
  await client.end();
  return { inserted, skipped, skuCol, qtyCol };
}

// ====== 네이버 웍스 이메일에서 인증번호 6자리 추출 ======
async function getAuthCodeFromEmail() {
  console.log(`메일함(${EMAIL_USER}) 접속 시도 중...`);
  const config = {
    imap: {
      user: EMAIL_USER,
      password: EMAIL_PW,
      host: "imap.worksmobile.com",
      port: 993,
      tls: true,
      authTimeout: 15000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  try {
    const connection = await imaps.connect(config);
    await connection.openBox("INBOX");
    const searchCriteria = ["UNSEEN"];
    const fetchOptions = { bodies: [""], markSeen: true };
    const messages = await connection.search(searchCriteria, fetchOptions);

    if (!messages || messages.length === 0) {
      connection.end();
      throw new Error("새로운 인증 메일이 없습니다. 발송 주소를 다시 확인해 보세요.");
    }

    const lastMessage = messages[messages.length - 1];
    const part = lastMessage.parts.find(p => p.which === "");
    const mail = await simpleParser(part.body);
    const text = mail.text || mail.html || "";
    connection.end();

    const match = text.match(/\b\d{6}\b/);
    if (match) return match[0];
    throw new Error("본문에서 6자리 숫자를 찾지 못했습니다.");
  } catch (err) {
    throw new Error("IMAP 메일 읽기 실패: " + err.message);
  }
}

// ====== 1. 로그인 및 2단계 인증 돌파 (첫 번째 계정 기본 사용) ======
async function loginAndSaveStorageState() {
  console.log("로봇이 11번가 자동 로그인을 시작합니다...");
  ensureDir(STORAGE_STATE_PATH);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[name="loginName"], input[name="id"]', SELLER_ID);
  await page.fill('input[name="passWord"], input[name="pw"]', SELLER_PW);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    page.click('button:has-text("로그인")').catch(() => {}),
  ]);

  if (page.url().includes("otp") || await page.locator('text="로그인 2단계 인증"').isVisible()) {
    console.log("🔒 2단계 인증 화면 감지됨! 첫 번째 계정으로 진행합니다.");

    // 첫 번째 계정(정*라, ID: nldList_0)은 보통 기본 선택이 되어 있습니다.
    // 만약 안 되어 있을 경우를 대비해 확실히 한 번 클릭해 줍니다.
    console.log("첫 번째 계정(nldList_0)을 명시적으로 클릭합니다.");
    await page.locator('#nldList_0, tr:has-text("정*라")').first().click({ force: true }).catch(() => {});
    
    await page.waitForTimeout(1000); 

    console.log("[인증정보 선택하기] 버튼 클릭!");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
      page.click('button:has-text("인증정보 선택하기")')
    ]);

    // 알림창 자동 확인
    page.once("dialog", async dialog => { await dialog.accept(); });

    // 이메일 옵션 선택 (첫 번째 이메일 주소 확인)
    console.log("첫 번째 이메일 옵션을 선택합니다...");
    await page.locator('tr:has-text("conta")').first().click({ force: true }).catch(() => {
        // 텍스트 기반 찾기 실패 시 첫 번째 라디오 버튼 클릭
        return page.locator('input[type="radio"]').first().click({ force: true });
    });
    
    console.log("[인증번호 전송] 버튼 클릭!");
    await page.locator('button:has-text("인증번호 전송"):visible').first().click();
    
    console.log("📧 메일 도착 대기 중 (25초)...");
    await page.waitForTimeout(25000);
    const authCode = await getAuthCodeFromEmail();
    console.log(`✅ 가로챈 인증번호: ${authCode}`);

    // 번호 입력 및 확인
    const authInput = page.locator('input[type="text"]:visible, input[type="tel"]:visible').first();
    await authInput.fill(authCode);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      page.click('button:has-text("확인")')
    ]);
    console.log("🔓 2단계 인증 돌파 성공!");
  }

  await page.goto("https://soffice.11st.co.kr", { waitUntil: "domcontentloaded", timeout: 60000 });
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log("자동 로그인 세션 저장 완료!");

  await context.close();
  await browser.close();
}

async function downloadExcelWithPlaywrightOnce() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH, acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(TARGET_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (page.url().includes("login")) throw new Error("HTML이 내려왔습니다 (세션 만료)");

    await page.click('button:has-text("검색")');
    await page.waitForTimeout(3000);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.click('button:has-text("엑셀다운로드")')
    ]);

    ensureDir(DOWNLOAD_PATH);
    await download.saveAs(DOWNLOAD_PATH);
    console.log("✅ 엑셀 다운로드 성공!");

    await context.close();
    await browser.close();
    return { filePath: DOWNLOAD_PATH };
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function downloadExcelWithPlaywright() {
  if (!fs.existsSync(STORAGE_STATE_PATH)) await loginAndSaveStorageState();
  try {
    return await downloadExcelWithPlaywrightOnce();
  } catch (e) {
    if (String(e).includes("HTML이 내려왔습니다")) {
      await loginAndSaveStorageState();
      return await downloadExcelWithPlaywrightOnce(); 
    }
    throw e;
  }
}

function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  return { sheetName, rowsCount: XLSX.utils.sheet_to_json(ws).length, rows: XLSX.utils.sheet_to_json(ws, { defval: "" }) };
}

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.post("/run", async (req, res) => {
  try {
    const startedAt = new Date().toISOString();
    const dl = await downloadExcelWithPlaywright();
    const parsed = parseExcel(dl.filePath);
    const db = await upsertRowsToPostgres(parsed.rows);
    res.json({ ok: true, startedAt, downloaded: dl, db });
  } catch (e) {
    console.error("실행 중 에러 발생:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Playwright server listening on :${PORT}`));
