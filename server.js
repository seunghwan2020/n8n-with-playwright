const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const { Client } = require("pg");

const app = express();
app.use(express.json({ limit: "5mb" }));

// ====== 필수 환경변수 ======
const PG_URL = process.env.PG_URL || process.env.DATABASE_URL;
const SAVED_COOKIES = process.env.SAVED_COOKIES; // Railway에 넣은 쿠키 JSON
const DOWNLOAD_PATH = "/data/stock.xlsx";
const UPSERT_TABLE = process.env.UPSERT_TABLE || "n_delivery_stock";

// 목표 페이지 URL (승환님이 주신 화면)
const TARGET_PAGE_URL = "https://soffice.11st.co.kr/view/40394";

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

  if (!skuCol || !qtyCol) throw new Error(`엑셀 컬럼을 못 찾았습니다.`);

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

// ====== 핵심: 쿠키로 로그인 후 화면에서 버튼 클릭해서 다운로드 ======
async function downloadExcelWithPlaywright() {
  if (!SAVED_COOKIES) {
    throw new Error("SAVED_COOKIES 환경변수가 없습니다. Cookie-Editor로 복사해서 Railway에 넣어주세요.");
  }

  console.log("브라우저를 실행합니다...");
  const browser = await chromium.launch({
    headless: true, // 에러 추적 시 잠시 false로 변경 가능
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({ acceptDownloads: true });

  try {
    // 1. 쿠키 세팅 (로그인 프리패스)
    const cookies = JSON.parse(SAVED_COOKIES);
    await context.addCookies(cookies);
    console.log("쿠키 세팅 완료! 로그인 없이 곧바로 이동합니다.");

    const page = await context.newPage();

    // 2. N배송 재고관리 화면으로 이동
    console.log("재고 화면으로 이동 중...");
    await page.goto(TARGET_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 3. [검색] 버튼 클릭 및 로딩 대기
    console.log("[검색] 버튼을 클릭합니다.");
    await page.click('button:has-text("검색")');
    await page.waitForTimeout(3000); // 검색 결과가 뜰 때까지 3초 대기

    // 4. [엑셀다운로드] 버튼 클릭
    console.log("[엑셀다운로드] 버튼을 클릭합니다.");
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.click('button:has-text("엑셀다운로드"), a:has-text("엑셀다운로드")')
    ]);

    // 5. 파일 저장
    ensureDir(DOWNLOAD_PATH);
    await download.saveAs(DOWNLOAD_PATH);
    console.log("✅ 엑셀 파일 다운로드 및 저장 성공!");

    await context.close();
    await browser.close();

    return { filePath: DOWNLOAD_PATH };

  } catch (error) {
    console.error("다운로드 중 에러 발생:", error);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
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
