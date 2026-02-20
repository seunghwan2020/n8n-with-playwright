const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const { Client } = require("pg");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== 필수 환경변수 ======
const DOWNLOAD_URL = process.env.DOWNLOAD_URL;
const PG_URL = process.env.PG_URL || process.env.DATABASE_URL;
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH || "/data/storageState.json";
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || "/data/stock.xlsx";
const UPSERT_TABLE = process.env.UPSERT_TABLE || "n_delivery_stock";

const LOGIN_URL = process.env.LOGIN_URL;
const SELLER_ID = process.env.SELLER_ID;
const SELLER_PW = process.env.SELLER_PW;

const COL_SKU_CANDIDATES = ["SKU", "sku", "상품SKU", "SellerSKU", "판매자SKU", "옵션SKU"];
const COL_QTY_CANDIDATES = ["재고", "재고수량", "수량", "재고수", "Stock", "stock_qty"];

// ====== 유틸 ======
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
  if (!PG_URL) throw new Error("PG_URL (or DATABASE_URL) 환경변수가 없습니다.");

  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  await ensureTable(client);

  let inserted = 0;
  let skipped = 0;

  const firstRow = rows.find(r => r && typeof r === "object");
  if (!firstRow) return { inserted: 0, skipped: rows.length };

  const skuCol = pickCol(firstRow, COL_SKU_CANDIDATES);
  const qtyCol = pickCol(firstRow, COL_QTY_CANDIDATES);

  if (!skuCol || !qtyCol) {
    const sampleKeys = Object.keys(firstRow || {});
    throw new Error(`엑셀 컬럼을 못 찾았습니다. skuCol=${skuCol}, qtyCol=${qtyCol}. 첫 행 컬럼들: ${sampleKeys.join(", ")}`);
  }

  const stmt = `
    INSERT INTO ${UPSERT_TABLE} (sku, stock_qty, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (sku)
    DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = NOW();
  `;

  for (const r of rows) {
    if (!r || typeof r !== "object") { skipped++; continue; }
    const sku = String(r[skuCol] ?? "").trim();
    if (!sku) { skipped++; continue; }

    const rawQty = r[qtyCol];
    const qty = Number(String(rawQty).replace(/,/g, "").trim());
    if (!Number.isFinite(qty)) { skipped++; continue; }

    await client.query(stmt, [sku, qty]);
    inserted++;
  }

  await client.end();
  return { inserted, skipped, skuCol, qtyCol };
}

// ====== 1. 자동 로그인 및 세션 저장 함수 ======
async function loginAndSaveStorageState() {
  console.log("자동 로그인을 시작합니다...");
  if (!LOGIN_URL) throw new Error("LOGIN_URL 환경변수가 없습니다.");
  if (!SELLER_ID) throw new Error("SELLER_ID 환경변수가 없습니다.");
  if (!SELLER_PW) throw new Error("SELLER_PW 환경변수가 없습니다.");

  ensureDir(STORAGE_STATE_PATH);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  await page.fill('input[name="loginName"], input[name="id"], input[type="text"]', SELLER_ID);
  await page.fill('input[name="passWord"], input[name="pw"], input[type="password"]', SELLER_PW);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
    page.click('button[type="submit"], input[type="submit"], button:has-text("로그인")').catch(() => {}),
  ]);

  await page.goto("https://soffice.11st.co.kr", { waitUntil: "domcontentloaded", timeout: 60000 });

  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log("자동 로그인 성공 및 세션 저장 완료!");

  await context.close();
  await browser.close();

  return { saved: true, storageStatePath: STORAGE_STATE_PATH };
}

// ====== 2. 엑셀 다운로드 1회 시도 함수 (API 방식으로 완전 교체!) ======
async function downloadExcelWithPlaywrightOnce() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH
  });

  try {
    console.log("엑셀 다운로드를 요청합니다...");

    // 브라우저 화면을 띄워서 다운로드를 기다리지 않고, 
    // 저장된 로그인 세션(쿠키)을 이용해 엑셀 파일을 백그라운드에서 직접 당겨옴 (충돌 방지 100%)
    const response = await context.request.get(DOWNLOAD_URL, {
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://soffice.11st.co.kr/"
      }
    });

    const ct = response.headers()["content-type"] || "";
    if (ct.includes("text/html")) {
      const html = await response.text();
      throw new Error(`엑셀이 아니라 HTML이 내려왔습니다(세션 만료/차단 가능).\nHTML 일부: ${html.slice(0, 300)}`);
    }

    // 정상 엑셀 파일인 경우 저장
    const buffer = await response.body();
    ensureDir(DOWNLOAD_PATH);
    fs.writeFileSync(DOWNLOAD_PATH, buffer);
    console.log("엑셀 파일 다운로드 및 저장 성공!");

    await context.close();
    await browser.close();

    return { filePath: DOWNLOAD_PATH };

  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

// ====== 3. 다운로드 실행 ======
async function downloadExcelWithPlaywright() {
  if (!DOWNLOAD_URL) throw new Error("DOWNLOAD_URL 환경변수가 없습니다.");

  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.log("저장된 세션이 없습니다. 최초 로그인을 시도합니다.");
    await loginAndSaveStorageState();
  }

  try {
    return await downloadExcelWithPlaywrightOnce();
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("HTML이 내려왔습니다")) {
      console.log("세션 만료가 감지되었습니다. 재로그인을 시도합니다...");
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
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return { sheetName, rowsCount: rows.length, rows };
}

// ====== 라우트 ======
app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.post("/run", async (req, res) => {
  try {
    const startedAt = new Date().toISOString();

    const dl = await downloadExcelWithPlaywright();
    const parsed = parseExcel(dl.filePath);
    const db = await upsertRowsToPostgres(parsed.rows);

    res.json({
      ok: true,
      startedAt,
      downloaded: dl,
      parsed: { sheetName: parsed.sheetName, rowsCount: parsed.rowsCount },
      db
    });
  } catch (e) {
    console.error("실행 중 에러 발생:", e);
    res.status(500).json({
      ok: false,
      error: String(e?.message || e)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Playwright server listening on :${PORT}`));
