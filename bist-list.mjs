// BIST hisse listesini otomatik günceller -> bist-symbols.txt  ve  data/bist-meta.json (ad, sektör, piyasa değeri)
// Kaynak: TradingView tarama servisi (resmî olmayan, ücretsiz). Kullanım: node bist-list.mjs
// Liste beklenenden kısa gelirse (servis değişti / engellendi) mevcut dosyalar korunur.
import fs from 'node:fs';

const body = {
  filter: [{ left: 'type', operation: 'equal', right: 'stock' }],
  options: { lang: 'tr' },
  markets: ['turkey'],
  symbols: { query: { types: [] }, tickers: [] },
  columns: ['name', 'description', 'sector', 'industry', 'market_cap_basic', 'subtype'],
  sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
  range: [0, 1500],
};

let json;
for (let a = 0; a < 3; a++) {
  try {
    const r = await fetch('https://scanner.tradingview.com/turkey/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.tradingview.com' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { console.error(`HTTP ${r.status}`); await new Promise(x => setTimeout(x, 2000 * (a + 1))); continue; }
    json = await r.json();
    break;
  } catch (e) { console.error(e.message); await new Promise(x => setTimeout(x, 2000)); }
}

const rows = (json?.data || [])
  .filter(x => x.s?.startsWith('BIST:'))
  .map(x => ({ sym: x.s.slice(5), name: x.d[1] || x.d[0], sector: x.d[2] || null, industry: x.d[3] || null, mcap: x.d[4] || null, subtype: x.d[5] }))
  .filter(x => /^[A-Z0-9]{3,6}$/.test(x.sym) && !['preferred', 'dr', 'unit', 'warrant'].includes(x.subtype));

console.log(`BIST listesi: ${rows.length} hisse`);
if (rows.length < 300) { console.error('Liste beklenenden kısa geldi, mevcut dosyalar korunuyor.'); process.exit(1); }

const syms = [...new Set(rows.map(x => x.sym))].sort();
fs.writeFileSync('bist-symbols.txt', syms.join('\n') + '\n');
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/bist-meta.json', JSON.stringify({
  updated: new Date().toISOString(), count: rows.length,
  stocks: Object.fromEntries(rows.map(x => [x.sym, { name: x.name, sector: x.sector, industry: x.industry, mcap: x.mcap }])),
}));
