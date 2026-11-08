// Finlital AI Bülten  ->  data/brief.json
// radar.json'daki SAYILARI Türkçe, sade bir dille özetler. Yapay zeka fiyat tahmini yapmaz, al/sat demez; yalnızca verilen veriyi yorumlar.
// ANTHROPIC_API_KEY tanımlıysa Claude ile yazar; yoksa veya hata olursa kural tabanlı şablona düşer (site her koşulda çalışır).
import fs from 'node:fs';
const R = JSON.parse(fs.readFileSync('data/radar.json', 'utf8'));
const MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5', KEY = process.env.ANTHROPIC_API_KEY;
const MK = { bist: 'BIST', nasdaq: 'NASDAQ' }, SETUP = { trend: 'trend momentumu', dip: 'dip tepkisi' };
const top = R.signals.slice(0, 12);

function tplMarket(mk) {
  const g = R.regime[mk]; if (!g) return '';
  const n = R.signals.filter(s => s.mk === mk).length;
  const tone = g.label === 'güçlü' ? 'Genel görünüm güçlü; hisselerin çoğu orta vadeli ortalamasının üzerinde.' : g.label === 'zayıf' ? 'Genel görünüm zayıf; hisselerin çok azı orta vadeli ortalamasının üzerinde, bu yüzden yükseliş sinyalleri daha az güvenilir olabilir.' : 'Genel görünüm karışık; piyasa net bir yön göstermiyor.';
  return `${MK[mk]}: hisselerin %${g.above50}'i SMA 50, %${g.above200}'ü SMA 200 üzerinde; son 21 günde ortalama değişim %${g.avg21}. ${tone} Radarda bu piyasadan ${n} aday var.`;
}
function tplStock(s) {
  const lead = s.setup === 'trend' ? `${s.sym} güçlü bir yükseliş trendinde.` : `${s.sym} kısa vadede sert satılmış durumda.`;
  return `${lead} ${s.reasons.slice(0, 3).join('; ')}. Referans stop ${s.stop}, referans hedef ${s.target} (risk %${s.risk}). Bu bir tavsiye değil, geçmiş verinin sınıflandırmasıdır.`;
}
const fallback = () => ({ ai: false, market: Object.fromEntries(Object.keys(R.regime).map(m => [m, tplMarket(m)])), stocks: Object.fromEntries(top.map(s => [`${s.mk}:${s.sym}`, tplStock(s)])),
  summary: `Radar bugün ${R.total} aday listeledi. ` + Object.keys(R.regime).map(m => tplMarket(m)).join(' ') });

async function ai() {
  const data = { tarih: Object.values(R.regime)[0]?.date, piyasalar: R.regime, adaylar: top.map(s => ({ id: `${s.mk}:${s.sym}`, kurulum: SETUP[s.setup], puan: s.score, fiyat: s.price, stop: s.stop, hedef: s.target, riskYuzde: s.risk, rsi: s.rsi, r21: s.r21, r63: s.r63, zirveUzaklik: s.hi, hacimKati: s.volx, nedenler: s.reasons })),
    gecmisTest: { islem: R.backtest.all.n, kazanma: R.backtest.all.win, ortGetiri: R.backtest.all.avg, donemB: R.backtest.periods.B } };
  const system = 'Sen Finlital için çalışan bir piyasa veri yorumcususun. Kurallar: (1) Yalnızca verilen JSON verisini kullan, sayı uydurma. (2) Fiyat tahmini yapma, "al", "sat", "tut", "kesin", "garanti" deme; yatırım tavsiyesi verme. (3) Sade, dürüst, Türkçe yaz; riskleri ve belirsizliği açıkça söyle. (4) Piyasa genişliği zayıfsa bunu vurgula. (5) Yalnızca geçerli JSON döndür, başka metin yok.';
  const user = `Aşağıdaki veriyle şu şemada JSON üret: {"summary": "3-4 cümlelik günün özeti", "market": {"bist": "2-3 cümle", "nasdaq": "2-3 cümle"}, "stocks": {"<id>": "2-3 cümle, bu adayın neden listelendiği ve dikkat edilecek risk"}}. Her aday id'si için bir giriş yaz.\n\n${JSON.stringify(data)}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }) });
  if (!r.ok) throw new Error('API ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const txt = (await r.json()).content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
  const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  const clean = s => String(s || '').replace(/\b(kesin|garanti|mutlaka)\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const fb = fallback(), out = { ai: true, model: MODEL, summary: clean(j.summary) || fb.summary, market: {}, stocks: {} };
  for (const m of Object.keys(R.regime)) out.market[m] = clean(j.market?.[m]) || fb.market[m];
  for (const s of top) { const id = `${s.mk}:${s.sym}`; out.stocks[id] = clean(j.stocks?.[id]) || fb.stocks[id]; }
  return out;
}
let out; try { out = KEY ? await ai() : fallback(); if (!KEY) console.log('ANTHROPIC_API_KEY yok: şablon kullanıldı'); } catch (e) { console.log('AI hatası, şablona düşüldü:', e.message); out = fallback(); }
out.updated = new Date().toISOString(); out.disclaimer = 'Yapay zeka verilen sayıları özetler; fiyat tahmini veya yatırım tavsiyesi değildir.';
fs.writeFileSync('data/brief.json', JSON.stringify(out));
console.log('brief:', out.ai ? 'AI' : 'şablon', '| aday özeti:', Object.keys(out.stocks).length);
