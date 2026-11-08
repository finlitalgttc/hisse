// Finlital Radar Motoru v2  ->  data/radar.json, data/radar-log.json
// Çok faktörlü, şeffaf puanlama (0-100). Yapay zeka FİYAT TAHMİNİ YAPMAZ; veriyi sınıflandırır, geçmiş testle ölçer, canlı sonucu kaydeder.
// Girdi: data/h/{bist,nasdaq}/*.json  ([t,o,h,l,c,v] günlük).  Yatırım tavsiyesi değildir.
import fs from 'node:fs';

const CFG = {
  minBars: 300, hold: 10, atrStop: 1.5, atrTarget: 1.5, cool: 10,
  minTurn: { bist: 5e6, nasdaq: 2e6 },
  costPct: { bist: 0.20, nasdaq: 0.10 },     // gidiş-dönüş maliyet varsayımı (%), getirilerden düşülür
  minList: 55, maxList: 60, logTopPerMarket: 10, splitDate: '2025-01-01',
  bands: [0, 55, 65, 75, 101],
};
const clamp01 = x => Math.max(0, Math.min(1, x));
const DAY = 864e5, dkey = t => Math.floor(t / DAY), iso = t => new Date(t).toISOString().slice(0, 10);

function sma(a, n) { const o = new Float64Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function rsi14(c) { const n = 14, o = new Float64Array(c.length).fill(NaN); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { g /= n; l /= n; o[i] = 100 - 100 / (1 + (l ? g / l : 1e9)); } } else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = 100 - 100 / (1 + (l ? g / l : 1e9)); } } return o; }
function prep(rows) {
  const n = rows.length, t = rows.map(r => r[0]), o = rows.map(r => r[1]), h = rows.map(r => r[2]), l = rows.map(r => r[3]), c = rows.map(r => r[4]), v = rows.map(r => r[5]);
  const tr = new Float64Array(n); tr[0] = h[0] - l[0]; for (let i = 1; i < n; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  const atr = sma(tr, 14), ret1 = new Float64Array(n); for (let i = 1; i < n; i++) ret1[i] = c[i] / c[i - 1] - 1;
  const vol21 = new Float64Array(n).fill(NaN); for (let i = 22; i < n; i++) { let m = 0; for (let j = i - 20; j <= i; j++) m += ret1[j]; m /= 21; let s = 0; for (let j = i - 20; j <= i; j++) s += (ret1[j] - m) ** 2; vol21[i] = Math.sqrt(s / 20); }
  const hi252 = new Float64Array(n).fill(NaN); for (let i = 120; i < n; i++) { let m = -Infinity; for (let j = Math.max(0, i - 251); j <= i; j++) m = Math.max(m, h[j]); hi252[i] = c[i] / m - 1; }
  const v20 = sma(v, 20), v5 = sma(v, 5), v60 = sma(v, 60), turn = sma(c.map((x, i) => x * v[i]), 20);
  return { n, t, o, h, l, c, v, atr, vol21, hi252, rsi: rsi14(c), s20: sma(c, 20), s50: sma(c, 50), s200: sma(c, 200), v20, v5, v60, turn };
}
function outcome(P, i, atrAbs, stopMul = CFG.atrStop, tgtMul = CFG.atrTarget) {      // giriş: ertesi gün açılışı; aynı gün ikisi de değerse temkinli: stop
  const e = P.o[i + 1], stop = e - stopMul * atrAbs, tgt = e + tgtMul * atrAbs, end = Math.min(i + CFG.hold, P.n - 1);
  for (let j = i + 1; j <= end; j++) { if (P.l[j] <= stop) return { res: 'stop', r: stop / e - 1, e, stop, tgt, done: true }; if (P.h[j] >= tgt) return { res: 'hedef', r: tgt / e - 1, e, stop, tgt, done: true }; }
  if (end - i >= CFG.hold) return { res: 'süre', r: P.c[end] / e - 1, e, stop, tgt, done: true };
  return { res: 'açık', r: P.c[end] / e - 1, e, stop, tgt, done: false };
}

/* ---- piyasa genişliği (breadth) ve momentum sıralaması için tarih bazlı toplamlar ---- */
const S = { bist: {}, nasdaq: {} }, breadth = { bist: new Map(), nasdaq: new Map() }, r63map = { bist: new Map(), nasdaq: new Map() };
for (const mk of ['bist', 'nasdaq']) {
  const dir = `data/h/${mk}`; if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    let rows; try { rows = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
    if (rows.length < CFG.minBars) continue;
    const sym = f.replace('.json', ''), P = prep(rows); S[mk][sym] = P;
    for (let i = 200; i < P.n; i++) {
      const k = dkey(P.t[i]); let b = breadth[mk].get(k); if (!b) breadth[mk].set(k, b = { a50: 0, a200: 0, n: 0, r21: 0 });
      b.n++; if (P.c[i] > P.s50[i]) b.a50++; if (P.c[i] > P.s200[i]) b.a200++; b.r21 += P.c[i] / P.c[i - 21] - 1;
      if (i >= 63) { let arr = r63map[mk].get(k); if (!arr) r63map[mk].set(k, arr = []); arr.push(P.c[i] / P.c[i - 63] - 1); }
    }
  }
  for (const arr of r63map[mk].values()) arr.sort((a, b) => a - b);
}
const rank63 = (mk, k, v) => { const a = r63map[mk].get(k); if (!a || a.length < 50) return NaN; let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo / a.length; };
const breadthAt = (mk, k) => { const b = breadth[mk].get(k); return b && b.n >= 50 ? b.a50 / b.n : NaN; };

/* ---- kurulumlar (setup) ve puanlama ---- */
function evaluate(mk, P, i) {
  const c = P.c[i], k = dkey(P.t[i]);
  if (i < 210 || !(P.atr[i] > 0) || isNaN(P.rsi[i]) || isNaN(P.s200[i]) || isNaN(P.hi252[i]) || isNaN(P.vol21[i]) || isNaN(P.v60[i]) || !(P.v20[i] > 0)) return null;
  const br = breadthAt(mk, k); if (isNaN(br)) return null;
  const atrp = P.atr[i] / c, rk = rank63(mk, k, c / P.c[i - 63] - 1), ds200 = c / P.s200[i] - 1, r5 = c / P.c[i - 5] - 1;
  const volx = P.v[i] / P.v20[i], volx5 = P.v5[i] / (P.v60[i] + 1e-9);
  const out = [];
  // A) Trend momentumu: güçlü, trendde, 52 hafta zirvesine yakın, piyasa genişliği çökmemiş
  if (!isNaN(rk) && rk >= 0.70 && c > P.s50[i] && c > P.s200[i] && P.hi252[i] >= -0.12 && P.rsi[i] >= 50 && P.rsi[i] <= 78 && br >= 0.40 && atrp <= 0.08) {
    const align = P.s20[i] > P.s50[i] && P.s50[i] > P.s200[i] ? 1 : P.s50[i] > P.s200[i] ? 0.5 : 0;
    const sc = 100 * (0.30 * clamp01((rk - 0.70) / 0.30) + 0.20 * align + 0.15 * clamp01(1 + P.hi252[i] / 0.12) + 0.10 * clamp01((volx5 - 0.8) / 0.8) + 0.15 * clamp01((br - 0.40) / 0.40) + 0.10 * (1 - clamp01((P.vol21[i] - 0.01) / 0.03)));
    out.push({ setup: 'trend', score: sc, reasons: [`Son 3 ayda piyasanın en güçlü %${Math.round((1 - rk) * 100) || 1}'lik dilimi`, align === 1 ? 'SMA 20 > 50 > 200 (tam hizalı yükseliş trendi)' : 'SMA 50 > 200 (uzun vade trendi yukarı)', `52 hafta zirvesine %${(-P.hi252[i] * 100).toFixed(1)} uzaklıkta`, `Piyasa genişliği: hisselerin %${Math.round(br * 100)}'i SMA 50 üstünde`, `RSI ${P.rsi[i].toFixed(0)}`] });
  }
  // B) Dip tepkisi: uzun vadeli trendi çökmemiş hissede aşırı satım
  if (P.rsi[i] < 30 && ds200 > -0.15 && atrp <= 0.10 && br >= 0.20) {
    const sc = 100 * (0.35 * clamp01((30 - P.rsi[i]) / 15) + 0.20 * clamp01((ds200 + 0.15) / 0.30) + 0.15 * clamp01((br - 0.20) / 0.50) + 0.15 * clamp01((volx - 1) / 2) + 0.15 * clamp01(-r5 / 0.10));
    out.push({ setup: 'dip', score: sc, reasons: [`RSI ${P.rsi[i].toFixed(0)} (aşırı satım)`, `SMA 200'e göre %${(ds200 * 100).toFixed(1)} (uzun vade trendi bozulmamış)`, `Son 5 günde %${(r5 * 100).toFixed(1)}`, `Hacim 20 gün ortalamasının ${volx.toFixed(1)} katı`] });
  }
  return out.length ? out.map(x => ({ ...x, atrp, rsi: P.rsi[i], r21: c / P.c[i - 21] - 1, r63: c / P.c[i - 63] - 1, hi252: P.hi252[i], volx, br })) : null;
}

/* ---- geriye dönük test (yalnızca sonucu belli günler) + taban oranı ---- */
const trades = [], base = { A: { n: 0, w: 0, s: 0 }, B: { n: 0, w: 0, s: 0 } };
const bandOf = s => CFG.bands.findIndex((b, i) => s >= b && s < CFG.bands[i + 1]);
for (const mk of ['bist', 'nasdaq']) for (const [sym, P] of Object.entries(S[mk])) {
  if (!(P.turn[P.n - 1] >= CFG.minTurn[mk])) continue;
  const cool = { trend: 0, dip: 0 }, cost = CFG.costPct[mk] / 100;
  for (let i = 210; i < P.n - CFG.hold - 1; i++) {
    cool.trend--; cool.dip--;
    if (!(P.atr[i] > 0)) continue;
    if (i % 5 === 0) { const o = outcome(P, i, P.atr[i]), grp = P.t[i] < Date.parse(CFG.splitDate) ? 'A' : 'B', r = o.r - cost; base[grp].n++; base[grp].s += r; if (r > 0) base[grp].w++; }
    const ev = evaluate(mk, P, i); if (!ev) continue;
    for (const e of ev) {
      if (cool[e.setup] > 0) continue; cool[e.setup] = CFG.cool;
      const o = outcome(P, i, P.atr[i]), r = o.r - cost;
      trades.push({ mk, sym, setup: e.setup, score: e.score, t: P.t[i], r, res: o.res });
    }
  }
}
const agg = arr => { const n = arr.length; if (!n) return { n: 0 }; const w = arr.filter(x => x.r > 0).length, sr = arr.reduce((a, x) => a + x.r, 0); return { n, win: +(100 * w / n).toFixed(1), avg: +(100 * sr / n).toFixed(2), tgt: +(100 * arr.filter(x => x.res === 'hedef').length / n).toFixed(1), stp: +(100 * arr.filter(x => x.res === 'stop').length / n).toFixed(1) }; };
const sp = Date.parse(CFG.splitDate), pick = (f) => trades.filter(f);
const baseAgg = g => g.n ? { n: g.n, win: +(100 * g.w / g.n).toFixed(1), avg: +(100 * g.s / g.n).toFixed(2) } : { n: 0 };
const backtest = {
  all: agg(trades), trend: agg(pick(x => x.setup === 'trend')), dip: agg(pick(x => x.setup === 'dip')),
  periods: { A: { label: '2022-2024', trades: agg(pick(x => x.t < sp)), base: baseAgg(base.A) }, B: { label: '2025-2026', trades: agg(pick(x => x.t >= sp)), base: baseAgg(base.B) } },
  bands: CFG.bands.slice(0, -1).map((b, i) => ({ from: b, to: Math.min(CFG.bands[i + 1], 100), ...agg(pick(x => bandOf(x.score) === i)), A: agg(pick(x => bandOf(x.score) === i && x.t < sp)), B: agg(pick(x => bandOf(x.score) === i && x.t >= sp)) })),
  byMarket: { bist: agg(pick(x => x.mk === 'bist')), nasdaq: agg(pick(x => x.mk === 'nasdaq')) },
};
// aylık basket eğrisi: her ayın ortalama işlem getirisi, kümülatif toplam (bileşik değil)
const byMonth = {}; for (const x of trades) { const m = iso(x.t).slice(0, 7); (byMonth[m] ||= []).push(x.r); }
let cum = 0, peak = 0, mdd = 0; const eq = Object.keys(byMonth).sort().map(m => { const a = byMonth[m], avg = a.reduce((p, q) => p + q, 0) / a.length; cum += avg; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); return { m, n: a.length, avg: +(avg * 100).toFixed(2), cum: +(cum * 100).toFixed(2) }; });
backtest.equity = eq; backtest.maxDrawdownPts = +(mdd * 100).toFixed(1); backtest.months = eq.length;

/* ---- bugünün sinyalleri ---- */
const now = Date.now(), signals = [], regime = {};
for (const mk of ['bist', 'nasdaq']) {
  const syms = Object.entries(S[mk]); if (!syms.length) continue;
  const lastT = Math.max(...syms.map(([, P]) => P.t[P.n - 1])), k = dkey(lastT), b = breadth[mk].get(k);
  if (b) {
    const hist = []; const ks = [...breadth[mk].keys()].sort((a, c) => a - c).slice(-120); for (const kk of ks) { const q = breadth[mk].get(kk); if (q.n >= 50) hist.push(+(100 * q.a50 / q.n).toFixed(0)); }
    const p50 = b.a50 / b.n, p200 = b.a200 / b.n;
    regime[mk] = { date: iso(lastT), n: b.n, above50: +(100 * p50).toFixed(0), above200: +(100 * p200).toFixed(0), avg21: +(100 * b.r21 / b.n).toFixed(1), label: p50 >= 0.6 && p200 >= 0.5 ? 'güçlü' : p50 <= 0.35 ? 'zayıf' : 'nötr', hist };
  }
  for (const [sym, P] of syms) {
    const i = P.n - 1; if (now - P.t[i] > 6 * DAY || !(P.turn[i] >= CFG.minTurn[mk])) continue;
    const ev = evaluate(mk, P, i); if (!ev) continue;
    for (const e of ev) { if (e.score < CFG.minList) continue; const c = P.c[i], a = P.atr[i];
      signals.push({ mk, sym, setup: e.setup, score: Math.round(e.score), date: iso(P.t[i]), price: +c.toFixed(2), stop: +(c - CFG.atrStop * a).toFixed(2), target: +(c + CFG.atrTarget * a).toFixed(2), risk: +(100 * CFG.atrStop * a / c).toFixed(1), atr: +(100 * e.atrp).toFixed(1), rsi: Math.round(e.rsi), r21: +(100 * e.r21).toFixed(1), r63: +(100 * e.r63).toFixed(1), hi: +(100 * e.hi252).toFixed(1), volx: +e.volx.toFixed(1), reasons: e.reasons }); }
  }
}
signals.sort((a, b) => b.score - a.score);
const top = signals.slice(0, CFG.maxList);

/* ---- canlı takip günlüğü ---- */
const LOG = 'data/radar-log.json'; let log = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
for (const mk of ['bist', 'nasdaq']) for (const s of signals.filter(x => x.mk === mk).slice(0, CFG.logTopPerMarket))
  if (!log.some(x => x.mk === s.mk && x.sym === s.sym && x.setup === s.setup && now - Date.parse(x.date) < 10 * DAY)) log.push({ mk: s.mk, sym: s.sym, setup: s.setup, score: s.score, date: s.date, price: s.price, status: 'açık', r: 0 });
for (const e of log) {
  if (e.status !== 'açık') continue; const P = S[e.mk]?.[e.sym]; if (!P) continue;
  const i = P.t.findIndex(t => iso(t) === e.date); if (i < 0 || i + 1 >= P.n) continue;
  const o = outcome(P, i, P.atr[i]); if (o.done) { e.status = o.res; e.r = +(100 * (o.r - CFG.costPct[e.mk] / 100)).toFixed(2); }
}
log = log.filter(e => now - Date.parse(e.date) < 400 * DAY);
const closed = log.filter(e => e.status !== 'açık').sort((a, b) => a.date < b.date ? -1 : 1);
let lc = 0; const liveCurve = closed.map(e => (lc += e.r, { d: e.date, cum: +lc.toFixed(2) }));
const live = { total: log.length, closed: closed.length, win: closed.filter(e => e.r > 0).length, avg: closed.length ? +(closed.reduce((a, e) => a + e.r, 0) / closed.length).toFixed(2) : null, curve: liveCurve.slice(-300) };

const out = { updated: new Date().toISOString(), config: CFG, regime, signals: top, total: signals.length, backtest, live,
  notes: ['Geçmiş test yalnızca bugün listede olan hisseleri içerir (hayatta kalma yanlılığı).', 'Giriş ertesi gün açılışı, çıkış stop/hedef/10 gün; maliyet varsayımı getirilerden düşülmüştür.', 'Puan, faktörlerin şeffaf bir bileşimidir; puan yükseldikçe isabet arttığı GARANTİ DEĞİLDİR — bant tablosu bunun gerçekte nasıl çalıştığını gösterir.'] };
fs.writeFileSync('data/radar.json', JSON.stringify(out)); fs.writeFileSync(LOG, JSON.stringify(log));
console.log('rejim', JSON.stringify(Object.fromEntries(Object.entries(regime).map(([k, v]) => [k, { l: v.label, a50: v.above50, a200: v.above200 }]))));
console.log('backtest', JSON.stringify({ all: backtest.all, trend: backtest.trend, dip: backtest.dip, A: backtest.periods.A, B: backtest.periods.B, mdd: backtest.maxDrawdownPts }));
console.log('bantlar', JSON.stringify(backtest.bands.map(b => [b.from, b.n, b.win, b.avg, b.A.win, b.A.avg, b.B.win, b.B.avg])));
console.log('bugün sinyal', signals.length, 'canlı', JSON.stringify({ ...live, curve: undefined }));
