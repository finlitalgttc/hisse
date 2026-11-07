// Hisse x emtia hassasiyet analizi  ->  data/hassasiyet.json
// Girdi : data/emtia.json, data/h/emtia/*.json, data/h/bist|nasdaq/*.json, data/bist.json, data/nasdaq.json
// Kullanım: node sensitivity.mjs   (önce commodities.mjs ve hist.mjs çalışmış olmalı)
//
// Yöntem (özet):
//  - Haftalık logaritmik getiriler (günlük gecikme/saat farkı gürültüsünü azaltır).
//  - BIST hisseleri USD'ye çevrilir (hisse / USDTRY): emtia zaten dolar cinsinden, aksi halde ilişkiyi kur belirler.
//  - Piyasa etkisi ayıklanır: y = a + b1 * piyasa + b2 * emtia. Raporlanan beta (b2) piyasa etkisinden arındırılmıştır.
//    Piyasa: BIST için BIST100 (USD), NASDAQ için NASDAQ100.
//  - Güven: örneklem uzunluğu ve beta'nın t istatistiğine göre; düşük işlem hacimli hisseler sıralamalardan çıkarılır.
//  - Etkilenme (impact) = beta x emtianın son 1 aylık değişimi. Tahmin değil, tarihsel duyarlılığın bugüne uygulanmasıdır.
import fs from 'node:fs';

const FACTOR_GROUPS = new Set(['Enerji', 'Metal', 'Tarım', 'Kripto']);
const EXCLUDE = new Set(['GRAMALTIN']);          // TL cinsinden türetilmiş seri, USD'ye çevrilmiş hisselerle karşılaştırılmaz
const MIN_WEEKS = 52, MAX_WEEKS = 260;
const MIN_USD_TURNOVER = 250_000;                // günlük ortalama işlem tutarı (USD) altı: düşük likidite
const TOP_N = 15;

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const addDays = (k, n) => new Date(Date.parse(k + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const weekKey = t => { const k = dayKey(t), d = (new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7; return addDays(k, -d); };

// [{t,c}] -> Map(haftaAnahtarı -> haftalık logaritmik getiri)
function weeklyReturns(points) {
  const wk = new Map();
  for (const [t, c] of points) if (c > 0) wk.set(weekKey(t), c);     // haftanın son kapanışı
  const ret = new Map();
  for (const [k, c] of wk) { const p = wk.get(addDays(k, -7)); if (p) ret.set(k, Math.log(c / p)); }
  return ret;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function corr(x, y) {
  const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
// y = a + b1*m + b2*c  ->  { b2, t }
function ols2(y, m, c) {
  const n = y.length, my = mean(y), mm = mean(m), mc = mean(c);
  let Smm = 0, Scc = 0, Smc = 0, Smy = 0, Scy = 0, Syy = 0;
  for (let i = 0; i < n; i++) {
    const dy = y[i] - my, dm = m[i] - mm, dc = c[i] - mc;
    Smm += dm * dm; Scc += dc * dc; Smc += dm * dc; Smy += dm * dy; Scy += dc * dy; Syy += dy * dy;
  }
  const det = Smm * Scc - Smc * Smc;
  if (!(det > 1e-18) || n < 8) return null;
  const b1 = (Smy * Scc - Scy * Smc) / det, b2 = (Scy * Smm - Smy * Smc) / det;
  const sse = Syy - b1 * Smy - b2 * Scy, s2 = Math.max(sse, 0) / (n - 3);
  const se = Math.sqrt(s2 * Smm / det);
  return { b2, t: se > 0 ? b2 / se : 0 };
}

/* ---------- girdileri yükle ---------- */
const emtia = readJson('data/emtia.json');
if (!emtia) { console.error('data/emtia.json yok. Önce commodities.mjs çalıştırın.'); process.exit(1); }
const meta = Object.fromEntries(emtia.items.map(x => [x.sym, x]));
const seriesOf = id => { const r = readJson(`data/h/emtia/${id}.json`); return r ? r.map(x => [x[0], x[4]]) : null; };

const usdtry = seriesOf('USDTRY');
if (!usdtry) { console.error('USDTRY geçmişi yok.'); process.exit(1); }
const fx = new Map(usdtry.map(([t, c]) => [dayKey(t), c]));

function toUsd(points) {                          // TL seriyi USD'ye çevir (eksik günlerde son kur)
  let last = null; const out = [];
  for (const [t, c] of points) { const k = fx.get(dayKey(t)); if (k) last = k; if (last) out.push([t, c / last]); }
  return out;
}
const marketBist = (() => { const s = seriesOf('BIST100'); return s ? weeklyReturns(toUsd(s)) : null; })();
const marketNas = (() => { const s = seriesOf('NASDAQ100'); return s ? weeklyReturns(s) : null; })();

const factors = {};
for (const it of emtia.items) {
  if (!FACTOR_GROUPS.has(it.group) || EXCLUDE.has(it.sym)) continue;
  const s = seriesOf(it.sym); if (!s) continue;
  factors[it.sym] = weeklyReturns(s);
}

/* ---------- hisse bazlı hesap ---------- */
const stocks = {}, perFactor = Object.fromEntries(Object.keys(factors).map(k => [k, []]));
let nStocks = 0;

for (const mk of ['bist', 'nasdaq']) {
  const list = readJson(`data/${mk}.json`)?.stocks || [];
  const info = Object.fromEntries(list.map(s => [s.sym, s]));
  const market = mk === 'bist' ? marketBist : marketNas;
  if (!market) { console.error(`${mk}: piyasa serisi yok, atlandı`); continue; }
  const dir = `data/h/${mk}`;
  if (!fs.existsSync(dir)) continue;

  for (const f of fs.readdirSync(dir)) {
    const sym = f.replace(/\.json$/, ''), rows = readJson(`${dir}/${f}`);
    if (!rows || rows.length < 120) continue;
    let pts = rows.map(r => [r[0], r[4]]);
    if (mk === 'bist') pts = toUsd(pts);
    const ret = weeklyReturns(pts);
    // likidite: son 60 işlem günü ortalama işlem tutarı (USD)
    const last = rows.slice(-60);
    const q = info[sym];
    const usdMul = mk === 'bist' ? 1 / (usdtry.at(-1)[1] || 1) : 1;
    const turnover = mean(last.map(r => r[4] * r[5])) * usdMul;
    const lowLiq = !(turnover >= MIN_USD_TURNOVER);

    const res = [];
    for (const [fid, fr] of Object.entries(factors)) {
      const keys = [...ret.keys()].filter(k => fr.has(k) && market.has(k)).slice(-MAX_WEEKS);
      if (keys.length < MIN_WEEKS) continue;
      const y = keys.map(k => ret.get(k)), m = keys.map(k => market.get(k)), c = keys.map(k => fr.get(k));
      const reg = ols2(y, m, c); if (!reg) continue;
      const k1 = Math.min(52, keys.length);
      const corr1y = corr(y.slice(-k1), c.slice(-k1));
      const n = keys.length, t = reg.t;
      // Çok sayıda emtia aynı anda test edildiği için eşikler yüksek tutulur (tesadüfi ilişkileri elemek için)
      const conf = n >= 156 && Math.abs(t) >= 3 ? 'yüksek' : n >= 104 && Math.abs(t) >= 2.5 ? 'orta' : 'düşük';
      const ch1m = meta[fid]?.ch1m;
      const impact = ch1m == null ? null : reg.b2 * ch1m;
      const row = { c: fid, corr: +corr(y, c).toFixed(3), beta: +reg.b2.toFixed(3), t: +t.toFixed(2), n, conf, corr1y: +corr1y.toFixed(3), impact: impact == null ? null : +impact.toFixed(2) };
      res.push(row);
      if (!lowLiq) perFactor[fid].push({ sym, mk, name: q?.name || sym, ...row, c: undefined });
    }
    if (!res.length) continue;
    res.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
    stocks[`${mk}:${sym}`] = { lowLiq, items: res.slice(0, 6) };
    nStocks++;
  }
}

/* ---------- emtia bazlı sıralama ---------- */
const commodities = {};
for (const [fid, arr] of Object.entries(perFactor)) {
  const pos = arr.filter(x => x.beta > 0 && x.t >= 2.5).sort((a, b) => b.t - a.t).slice(0, TOP_N);
  const neg = arr.filter(x => x.beta < 0 && x.t <= -2.5).sort((a, b) => a.t - b.t).slice(0, TOP_N);
  const m = meta[fid] || {};
  commodities[fid] = { name: m.name, group: m.group, chg: m.chg, ch1w: m.ch1w, ch1m: m.ch1m, tested: arr.length, pos, neg };
}

fs.writeFileSync('data/hassasiyet.json', JSON.stringify({
  updated: new Date().toISOString(),
  method: 'Haftalık log getiri; BIST hisseleri USD cinsine çevrildi; piyasa etkisi (BIST100/NASDAQ100) ayıklandı. Geçmiş ilişki gelecekte tekrarlanmayabilir; yatırım tavsiyesi değildir.',
  minWeeks: MIN_WEEKS, maxWeeks: MAX_WEEKS, count: nStocks, commodities, stocks,
}));
console.log(`hassasiyet: ${nStocks} hisse, ${Object.keys(factors).length} emtia/faktör`);
