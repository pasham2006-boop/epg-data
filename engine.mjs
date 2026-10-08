import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SITE    = 'https://dizitakvimi.com';
const DAYS    = 7;
const JSON_F  = 'dizi-epg.json';
const XML_F   = 'dizi-epg.xml';

const TR_MONTHS = { Ocak:0,Şubat:1,Mart:2,Nisan:3,Mayıs:4,Haziran:5,
  Temmuz:6,Ağustos:7,Eylül:8,Ekim:9,Kasım:10,Aralık:11 };

const pad   = n => String(n).padStart(2,'0');
const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addD  = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const today = () => { const d=new Date(); d.setHours(0,0,0,0); return d; };

function slugify(ad) {
  if (!ad) return '';
  return String(ad).toLowerCase()
    .replace(/ç/g,'c').replace(/ğ/g,'g').replace(/ı/g,'i')
    .replace(/ö/g,'o').replace(/ş/g,'s').replace(/ü/g,'u')
    .replace(/â/g,'a').replace(/î/g,'i').replace(/û/g,'u')
    .replace(/\b(hd|sd|fhd|uhd|4k|fullhd|full|tr|türk|turk|turkey)\b/gi,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-|-$/g,'');
}

async function scrapeDay(page, iso){
  const url = `${SITE}/calendar?view=calendar&date=${iso}`;
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForSelector('article', { timeout:20000 }).catch(()=>{});
  await page.waitForTimeout(500); // JS render bitsin

  return await page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('article')){
      const chAnchor = a.querySelector('a[href^="/channel/"]');
      out.push({
        time:      a.querySelector('time')?.textContent?.trim() || '',
        title:     a.querySelector('h3')?.textContent?.trim()   || '',
        channel:   chAnchor?.textContent?.trim()                || '',
        channelId: (chAnchor?.getAttribute('href')||'').replace('/channel/','') || 'unknown',
        tags:      [...a.querySelectorAll('span')].map(s=>s.textContent.trim())
                     .filter(t=>['Yeni Bölüm','Yeni','Tekrar','Final','Final Bölüm'].includes(t))
      });
    }
    return out;
  });
}

const t0 = today();
const wanted = Array.from({length:DAYS}, (_,i)=> ymd(addD(t0,i)));

let cache = { days:{} };
if (existsSync(JSON_F)){
  try {
    const old = JSON.parse(await readFile(JSON_F,'utf8'));
    if (old.kanallar) cache.days = {};
    else cache = old;
  } catch {}
}

const browser = await chromium.launch();
const page    = await browser.newPage({
  userAgent:'Mozilla/5.0 (compatible; dizi-epg/1.0)'
});

for (const iso of wanted){
  try {
    const items = await scrapeDay(page, iso);
    cache.days[iso] = items;
    console.log(`OK ${iso}  ${items.length} yayin`);
  } catch(e){
    console.warn(`HATA ${iso}  ${e.message}`);
  }
}
await browser.close();

const keep = new Set(wanted);
for (const k of Object.keys(cache.days)) if (!keep.has(k)) delete cache.days[k];

const byChannel = {};

for (const [iso, items] of Object.entries(cache.days)){
  for (const it of items){
    if (!it.time || !it.channel) continue;

    const [startT, endT] = it.time.split(' - ').map(x=>x?.trim());
    if (!startT) continue;

    const [sh, sm] = startT.split(':').map(Number);
    let [eh, em]   = (endT||'').split(':').map(Number);
    if (!endT){ eh = sh + 1; em = sm; }

    let stopISO = iso;
    if (endT && (eh < sh || (eh===sh && em<=sm))) stopISO = ymd(addD(new Date(iso+'T12:00:00'),1));

    const slug = slugify(it.channel);
    if (!slug) continue;

    if (!byChannel[slug]) byChannel[slug] = { isim: it.channel, programlar: [] };
    byChannel[slug].programlar.push({
      baslangic: `${iso}T${pad(sh)}:${pad(sm)}:00+03:00`,
      bitis:     `${stopISO}T${pad(eh)}:${pad(em)}:00+03:00`,
      baslik:    it.title || '',
      aciklama:  it.tags.join(' · ')
    });
  }
}

Object.values(byChannel).forEach(ch =>
  ch.programlar.sort((a,b)=> a.baslangic.localeCompare(b.baslangic))
);

const toplamProgram = Object.values(byChannel).reduce((s,c)=> s + c.programlar.length, 0);

const out = {
  at:            Date.now(),
  tarih:         wanted[0],
  kaynak:        'dizitakvimi.com',
  pencereBas:    wanted[0],
  pencereBit:    wanted[wanted.length-1],
  kanalSayisi:   Object.keys(byChannel).length,
  toplamProgram,
  kanallar:      byChannel
};

await writeFile(JSON_F, JSON.stringify(out, null, 2));
console.log(`-> ${JSON_F}  ${out.kanalSayisi} kanal, ${toplamProgram} program`);

const esc = s => String(s).replace(/[<>&"']/g, c =>
  ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));

let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="dizi-epg" source-info-url="${SITE}">\n`;
for (const [slug, ch] of Object.entries(byChannel)){
  xml += `  <channel id="${esc(slug)}"><display-name>${esc(ch.isim)}</display-name></channel>\n`;
}
for (const [slug, ch] of Object.entries(byChannel)){
  for (const p of ch.programlar){
    const start = p.baslangic.replace(/[-:]/g,'').replace('T','').slice(0,14) + ' +0300';
    const stop  = p.bitis.replace(/[-:]/g,'').replace('T','').slice(0,14) + ' +0300';
    xml += `  <programme start="${start}" stop="${stop}" channel="${esc(slug)}">\n`;
    xml += `    <title lang="tr">${esc(p.baslik)}</title>\n`;
    if (p.aciklama) xml += `    <desc lang="tr">${esc(p.aciklama)}</desc>\n`;
    xml += `  </programme>\n`;
  }
}
xml += `</tv>\n`;
await writeFile(XML_F, xml);
console.log(`-> ${XML_F}`);
