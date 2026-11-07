// Temel veriler (F/K, PD/DD, piyasa değeri, temettü verimi, hisse başı kâr, borçluluk, ROE, gelir, net kâr, sektör)
// -> data/temel.json   Kullanım: node fundamentals.mjs
// Kaynak: TradingView tarama servisi (resmî olmayan, ücretsiz). Alan adları zamanla değişebileceği için
// her metrik için birkaç aday ad denenir ve çalışan ilk ad seçilir; hangisinin seçildiği log'a yazılır.
import fs from 'node:fs';

const METRICS = {
  pe:   ['price_earnings_ttm'],
  pb:   ['price_book_fq', 'price_book_ratio'],
  mcap: ['market_cap_basic'],
  dy:   ['dividend_yield_recent', 'dividends_yield_current', 'dividends_yield'],
  eps:  ['earnings_per_share_basic_ttm', 'earnings_per_share_diluted_ttm'],
  de:   ['debt_to_equity', 'debt_to_equity_fq'],
  roe:  ['return_on_equity', 'return_on_equity_fq'],
  rev:  ['total_revenue_ttm', 'total_revenue'],
  ni:   ['net_income', 'net_income_ttm'],
};
const DEC = { pe: 2, pb: 2, dy: 2, eps: 4, de: 2, roe: 2, mcap: 0, rev: 0, ni: 0 };
const MARKETS = {
  bist:   { path: 'turkey',  filter: [], top: 1500 },
  nasdaq: { path: 'america', filter: [{ left: 'exchange', operation: 'equal', right: 'NASDAQ' }], top: 1500 },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scan(path, filter, columns, to) {
  const body = {
    filter: [{ left: 'type', operation: 'equal', right: 'stock' }, ...filter],
    options: { lang: 'tr' }, markets: [path], symbols: { query: { types: [] }, tickers: [] },
    columns, sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' }, range: [0, to],
  };
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://scanner.tradingview.com/${path}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.tradingview.com' },
        body: JSON.stringify(body),
      });
      if (r.status === 400) return null;                        // bilinmeyen alan adı
      if (!r.ok) { await sleep(2000 * (a + 1)); continue; }
      return (await r.json()).data || [];
    } catch { await sleep(1500); }
  }
  return null;
}

// Hangi alan adı çalışıyor?
const chosen = {};
for (const [key, names] of Object.entries(METRICS)) {
  for (const n of names) {
    const rows = await scan('turkey', [], [n], 60);
    if (rows && rows.some(x => x.d[0] != null)) { chosen[key] = n; break; }
  }
  console.log(`${key}: ${chosen[key] || 'BULUNAMADI'}`);
}
if (!chosen.pe || !chosen.mcap) { console.error('Temel alanlar bulunamadı, mevcut dosya korunuyor.'); process.exit(1); }

const keys = Object.keys(chosen), columns = [...keys.map(k => chosen[k]), 'sector'];
const out = { updated: new Date().toISOString() };
for (const [mk, { path, filter, top }] of Object.entries(MARKETS)) {
  const rows = await scan(path, filter, columns, top);
  if (!rows) { console.error(`${mk}: veri alınamadı`); continue; }
  const m = {};
  for (const x of rows) {
    const sym = x.s.split(':')[1];
    if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) continue;
    const o = {};
    keys.forEach((k, i) => { const v = x.d[i]; if (typeof v === 'number' && isFinite(v)) o[k] = +v.toFixed(DEC[k]); });
    const sec = x.d[keys.length]; if (sec) o.sector = sec;
    if (Object.keys(o).length) m[sym] = o;
  }
  out[mk] = m;
  console.log(`${mk}: ${Object.keys(m).length} hisse`);
}
if (Object.keys(out.bist || {}).length < 200) { console.error('BIST verisi beklenenden az, mevcut dosya korunuyor.'); process.exit(1); }
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/temel.json', JSON.stringify(out));
