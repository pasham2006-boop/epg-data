import * as cheerio from 'cheerio';
import { writeFile } from 'node:fs/promises';

const SITE   = 'https://1001dizi.net';
const URL    = SITE + '/haftalik-dizi-programi';
const DAYS   = 7;
const JSON_F = 'dizi-epg.json';
const XML_F  = 'dizi-epg.xml';

const TR_MONTHS = { Ocak:0,Şubat:1,Mart:2,Nisan:3,Mayıs:4,Haziran:5,
  Temmuz:6,Ağustos:7,Eylül:8,Ekim:9,Kasım:10,Aralık:11 };

const pad   = n => String(n).padStart(2,'0');
const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const addD  = (d,n) => { const x=new Date(d); x.setDate(x.getDate()+n); return x; };
const today = () => { const d=new Date(); d.setHours(0,0,0,0); return d; };

function slugify(ad) {
  if (!ad) return '';
  return String(ad).toLowerCase()
    .replace(/^tr\s*[:\-]\s*/i, '')
    .replace(/^tr\s+/i, '')
    .replace(/ç/g,'c').replace(/ğ/g,'g').replace(/ı/g,'i')
    .replace(/ö/g,'o').replace(/ş/g,'s').replace(/ü/g,'u')
    .replace(/â/g,'a').replace(/î/g,'i').replace(/û/g,'u')
    .replace(/\b(hd|sd|fhd|uhd|4k|fullhd|full)\b/gi,'')
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-|-$/g,'');
}

function parseTarih(txt) {
  const m = txt.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m) return null;
  const mo = TR_MONTHS[m[2]];
  if (mo === undefined) return null;
  return `${m[3]}-${pad(mo+1)}-${pad(+m[1])}`;
}

function addHours(iso, h) {
  const d = new Date(iso);
  d.setHours(d.getHours() + h);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00+03:00`;
}

async function main() {
  console.log('GET', URL);
  const res = await fetch(URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dizi-epg/2.0)' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  console.log('HTML boyut:', html.length);

  const $ = cheerio.load(html, { decodeEntities: false });
  const rows = $('table tr').toArray();
  console.log('Satır sayısı:', rows.length);
  if (rows.length < 3) throw new Error('Tablo bulunamadı');

  const gunler   = $(rows[0]).find('td').map((_,td) => $(td).text().trim()).get();
  const tarihler = $(rows[1]).find('td').map((_,td) => $(td).text().trim()).get();
  const tarihISO = tarihler.map(t => parseTarih(t));

  console.log('Günler:  ', gunler.join(' | '));
  console.log('Tarihler:', tarihler.join(' | '));

  const t0 = today();
  const wanted = new Set(Array.from({length:DAYS}, (_,i) => ymd(addD(t0,i))));
  console.log('Hedef pencere:', [...wanted].sort().join(', '));

  const items = [];
  let atlanan = 0;

  for (let r = 2; r < rows.length; r++) {
    const tds = $(rows[r]).find('td').toArray();
    for (let c = 0; c < tds.length; c++) {
      const iso = tarihISO[c];
      if (!iso || !wanted.has(iso)) continue;

      const td = $(tds[c]);
      const img = td.find('img').first();
      if (!img.length) continue;

      const afisRel = img.attr('src') || '';
      const afis = afisRel
        ? (afisRel.startsWith('http') ? afisRel : SITE + afisRel)
        : '';
      const altText = img.attr('alt') || '';

      // Kanal ismi alt attribute'undan: "Dizi Adı, Kanal"
      let diziAdi = '', kanal = '';
      if (altText.includes(',')) {
        const parts = altText.split(',').map(p => p.trim());
        diziAdi = parts[0];
        kanal = parts.slice(1).join(',').trim();
      }
      if (!diziAdi) diziAdi = td.find('a b').first().text().trim() || td.find('b').first().text().trim();
      if (!kanal) {
        const metin = td.text().replace(/\s+/g, ' ').trim();
        const kM = metin.match(/([a-zA-ZçğıöşüÇĞİÖŞÜ0-9\.]+)\s*-\s*\d{1,2}:\d{2}/);
        if (kM) kanal = kM[1].trim();
      }

      const metin = td.text().replace(/\s+/g, ' ').trim();
      const saatM = metin.match(/(\d{1,2}:\d{2})/);
      const saat = saatM ? saatM[1] : '';

      if (!diziAdi || !kanal || !saat) { atlanan++; continue; }

      const bolumM = metin.match(/(\d+)\.\s*Bölüm/i);
      const bolum = bolumM ? bolumM[1] + '. Bölüm' : '';

      const durumlar = [];
      td.find('font[color]').each((_, el) => {
        const t = $(el).text().trim().replace(/\s+/g, ' ');
        if (t) durumlar.push(t);
      });

      const aciklama = [bolum, ...durumlar].filter(Boolean).join(' · ');
      const kanalSlug = slugify(kanal);

      if (!kanalSlug) { atlanan++; continue; }

      items.push({
        kanalIsim: kanal,
        kanalSlug,
        baslangic: `${iso}T${saat}:00+03:00`,
        baslik:    diziAdi,
        afis,
        aciklama
      });
    }
  }

  console.log(`Toplam program: ${items.length} (atlanan: ${atlanan})`);

  /* ─── Kanal bazlı grupla ─── */
  const byChannel = {};
  for (const it of items) {
    if (!byChannel[it.kanalSlug]) {
      byChannel[it.kanalSlug] = { isim: it.kanalIsim, programlar: [] };
    }
    byChannel[it.kanalSlug].programlar.push({
      baslangic: it.baslangic,
      bitis:     '',
      baslik:    it.baslik,
      aciklama:  it.aciklama,
      afis:      it.afis
    });
  }

  /* Programları sırala + bitiş hesapla */
  for (const ch of Object.values(byChannel)) {
    ch.programlar.sort((a,b) => a.baslangic.localeCompare(b.baslangic));
    for (let i = 0; i < ch.programlar.length; i++) {
      const cur = ch.programlar[i];
      const next = ch.programlar[i+1];
      cur.bitis = next ? next.baslangic : addHours(cur.baslangic, 2);
    }
  }

  const toplamProgram = Object.values(byChannel).reduce((s,c) => s + c.programlar.length, 0);
  const wantedArr = [...wanted].sort();

  const out = {
    at:            Date.now(),
    tarih:         wantedArr[0],
    kaynak:        '1001dizi.net',
    pencereBas:    wantedArr[0],
    pencereBit:    wantedArr[wantedArr.length-1],
    kanalSayisi:   Object.keys(byChannel).length,
    toplamProgram,
    kanallar:      byChannel
  };

  await writeFile(JSON_F, JSON.stringify(out, null, 2));
  console.log(`\n-> ${JSON_F}  ${out.kanalSayisi} kanal, ${toplamProgram} program`);

  /* ─── XMLTV ─── */
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
}

main().catch(e => { console.error(e); process.exit(1); });
