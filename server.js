const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const { Client } = require("pg");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== 필수 환경변수 ======
// DOWNLOAD_URL: 엑셀 다운로드 URL (예: https://soffice.11st.co.kr/stock/BasisStockMgrAction.tmall?method=getSKUListListExcel ...)
// PG_URL: Postgres 연결 문자열 (Railway가 보통 DATABASE_URL로 줌)
// STORAGE_STATE_PATH: 세션 파일 경로 (기본 /data/storageState.json)
// DOWNLOAD_PATH: 다운로드 저장 경로 (기본 /data/stock.xlsx)
// UPSERT_TABLE: 저장 테이블명 (기본 n_delivery_stock)
const DOWNLOAD_URL = process.env.DOWNLOAD_URL;
const PG_URL = process.env.PG_URL || process.env.DATABASE_URL;
const STORAGE_STATE_PATH = process.env.STORAGE_STATE_PATH || "/data/storageState.json";
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || "/data/stock.xlsx";
const UPSERT_TABLE = process.env.UPSERT_TABLE || "n_delivery_stock";

// (선택) 엑셀 컬럼명 매핑: 너희 엑셀 실제 컬럼명에 맞춰 바꿔야 함
// 아래는 "예시"야. 실행 후 첫 성공에서 로그로 컬럼명 확인하고 수정하면 됨.
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
  // 아주 단순 테이블(필요하면 나중에 컬럼 늘려도 됨)
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

  // 컬럼 자동 추정(첫 행 기준)
  const firstRow = rows.find(r => r && typeof r === "object");
  if (!firstRow) return { inserted: 0, skipped: rows.length };

  const skuCol = pickCol(firstRow, COL_SKU_CANDIDATES);
  const qtyCol = pickCol(firstRow, COL_QTY_CANDIDATES);

  if (!skuCol || !qtyCol) {
    const sampleKeys = Object.keys(firstRow || {});
    throw new Error(
      `엑셀 컬럼을 못 찾았습니다. skuCol=${skuCol}, qtyCol=${qtyCol}. 첫 행 컬럼들: ${sampleKeys.join(", ")}`
    );
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

    // 수량은 숫자 변환
    const rawQty = r[qtyCol];
    const qty = Number(String(rawQty).replace(/,/g, "").trim());
    if (!Number.isFinite(qty)) { skipped++; continue; }

    await client.query(stmt, [sku, qty]);
    inserted++;
  }

  await client.end();
  return { inserted, skipped, skuCol, qtyCol };
}

async function downloadExcelWithPlaywright() {
  if (!DOWNLOAD_URL) throw new Error("DOWNLOAD_URL 환경변수가 없습니다.");

  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    throw new Error(
      `세션 파일이 없습니다: ${STORAGE_STATE_PATH}\n` +
      `→ 먼저 storageState.json을 /data/storageState.json에 올려야 합니다.`
    );
  }

  ensureDir(DOWNLOAD_PATH);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH,
    acceptDownloads: true
  });

  const page = await context.newPage();

  // 다운로드 트리거
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });

  // 엑셀 다운로드 URL로 이동
  const resp = await page.goto(DOWNLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // 혹시 HTML(로그인페이지/에러페이지)이 내려오면 여기서 감지 가능
  const ct = resp?.headers()?.["content-type"] || "";
  if (ct.includes("text/html")) {
    const html = await page.content();
    await browser.close();
    // 너무 길면 안 좋으니 앞부분만
    throw new Error(
      `엑셀이 아니라 HTML이 내려왔습니다(세션 만료/차단 가능). content-type=${ct}\n` +
      `HTML 일부: ${html.slice(0, 400)}`
    );
  }

  const download = await downloadPromise;
  await download.saveAs(DOWNLOAD_PATH);

  await context.close();
  await browser.close();

  return { filePath: DOWNLOAD_PATH, suggestedName: download.suggestedFilename() };
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

    // 1) 다운로드
    const dl = await downloadExcelWithPlaywright();

    // 2) 파싱
    const parsed = parseExcel(dl.filePath);

    // 3) DB 저장
    const db = await upsertRowsToPostgres(parsed.rows);

    res.json({
      ok: true,
      startedAt,
      downloaded: dl,
      parsed: { sheetName: parsed.sheetName, rowsCount: parsed.rowsCount },
      db
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Playwright server listening on :${PORT}`));
