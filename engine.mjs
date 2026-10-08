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

function parseTrDate(txt){
  const m = txt.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if(!m) return null;
  const mo = TR_MONTHS[m[2]];
  return mo===undefined ? null : `${m[3]}-${pad(mo+1)}-${pad(+m[1])}`;
}

function mondayOf(d) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0,0,0,0);
  return x;
}

/* ══════════════════════════════════════════════════════
   HAFTALIK TARAMA — tek istekte 7 gün!
   "view=week&start=YYYY-MM-DD" (Pazartesi) → tüm hafta
   ══════════════════════════════════════════════════════ */
async function scrapeWeek(page, weekStartISO){
  const url = `${SITE}/calendar?view=week&start=${weekStartISO}`;
  console.log('  GET', url);

  await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForSelector('article', { timeout:20000 }).catch(()=>{});
  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    const out = {};
    const sections = document.querySelectorAll('section');
    for (const sec of sections){
      const h2 = sec.querySelector('h2');
      if (!h2) continue;
      const dateText = h2.textContent.trim();
      // "9 Ekim 2026 Cuma" gibi tarih başlığı olan h2'ler
      if (!/\d{1,2}\s+\S+\s+\d{4}/.test(dateText)) continue;

      const items = [];
      for (const a of sec.querySelectorAll('article')){
        const chAnchor = a.querySelector('a[href^="/channel/"]');
        items.push({
          time:      a.querySelector('time')?.textContent?.trim() || '',
          title:     a.querySelector('h3')?.textContent?.trim()   || '',
          channel:   chAnchor?.textContent?.trim()                || '',
          channelId: (chAnchor?.getAttribute('href')||'').replace('/channel/','') || 'unknown',
          tags:      [...a.querySelectorAll('span')].map(s=>s.textContent.trim())
                       .filter(t=>['Yeni Bölüm','Yeni','Tekrar','Final','Final Bölüm'].includes(t))
        });
      }
      out[dateText] = items;
    }
    return out;
  });
}

/* ═══════════════ MAIN ═══════════════ */
const t0 = today();
const wanted = Array.from({length:DAYS}, (_,i)=> ymd(addD(t0,i)));
console.log('Hedef pencere:', wanted[0], '→', wanted[wanted.length-1]);

let cache = { days:{} };
if (existsSync(JSON_F)){
  try {
    const old = JSON.parse(await readFile(JSON_F,'utf8'));
    if (old.days) cache = old;
  } catch {}
}

const browser = await chromium.launch();
const page    = await browser.newPage({
  userAgent:'Mozilla/5.0 (compatible; dizi-epg/1.0)'
});

// Bu hafta + gelecek hafta (14 günü kapsar)
const thisMonday = mondayOf(t0);
const nextMonday = addD(thisMonday, 7);
const weekStarts = [ymd(thisMonday), ymd(nextMonday)];

for (const weekStart of weekStarts){
  try {
    console.log(`\n📅 Hafta: ${weekStart}`);
    const weekData = await scrapeWeek(page, weekStart);
    for (const [dateText, items] of Object.entries(weekData)){
      const iso = parseTrDate(dateText);
      if (!iso) continue;
      cache.days[iso] = items;
      console.log(`  OK ${iso}  ${items.length} yayin`);
    }
  } catch(e){
    console.warn(`  HATA ${weekStart}  ${e.message}`);
  }
}
await browser.close();

/* Rolling pencere — sadece bugün + 6 gün */
const keep = new Set(wanted);
for (const k of Object.keys(cache.days)) if (!keep.has(k)) delete cache.days[k];

/* ═══════════════ KANAL BAZLI DÖNÜŞÜM ═══════════════ */
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
    if (endT && (eh < sh || (eh===sh && em<=sm))) {
      stopISO = ymd(addD(new Date(iso+'T12:00:00'),1));
    }

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
console.log(`\n-> ${JSON_F}  ${out.kanalSayisi} kanal, ${toplamProgram} program`);

/* ═══════════════ XMLTV ═══════════════ */
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
