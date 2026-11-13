// Finlital ekonomik takvim güncelleyici — veri reposunda (finlitalgttc.github.io/hisse) GitHub Action ile çalıştır.
// Kullanım: node update-takvim.mjs data/takvim.json
// Elle girilen kayıtlar (src:"manual": TCMB/Fed/ECB tarihleri) KORUNUR; src:"ff" kayıtları her çalışmada yenilenir.
import fs from 'node:fs';
const file=process.argv[2]||'data/takvim.json';
const cur=JSON.parse(fs.readFileSync(file,'utf8'));
const manual=cur.events.filter(e=>e.src!=='ff');
const KEEP={USD:'US',EUR:'EU',GBP:'GB',JPY:'JP',CNY:'CN'};
let ff=[];
try{
  for(const w of ['thisweek','nextweek']){
    const r=await fetch(`https://nfs.faireconomy.media/ff_calendar_${w}.json`,{headers:{'user-agent':'finlital-calendar'}});
    if(!r.ok)continue;
    for(const x of await r.json()){
      const cc=KEEP[x.country];if(!cc||!['High','Medium'].includes(x.impact))continue;
      const t=new Date(x.date);if(isNaN(t))continue;
      ff.push({t:t.toISOString().replace('.000Z','Z'),cc,kind:'veri',title:x.title,imp:x.impact==='High'?3:2,prev:x.previous||null,fcst:x.forecast||null,src:'ff'});
    }
  }
}catch(e){console.error('ff alınamadı:',e.message)}
if(!ff.length)ff=cur.events.filter(e=>e.src==='ff');   // kaynak çökerse eski veriyi bozma
const now=Date.now()-864e5;
const events=[...manual,...ff].filter(e=>new Date(e.t).getTime()>=now).sort((a,b)=>a.t.localeCompare(b.t));
fs.writeFileSync(file,JSON.stringify({...cur,updated:new Date().toISOString(),events},null,1));
console.log('olay sayısı:',events.length);
