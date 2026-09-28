// ═══════════════════════════════════════════════════
// TVYAYINAKISI EPG MODÜLÜ v2.1 — IndexedDB
// ═══════════════════════════════════════════════════

const TVY_DB_NAME = 'pasham_tvy_epg_db';
const TVY_DB_STORE = 'epg';
const TVY_CACHE_SURESI = 6 * 24 * 60 * 60 * 1000; // 6 gün

let tvyData = null;

// ═══ IndexedDB Aç ═══
function tvyDbAc() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TVY_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(TVY_DB_STORE)) {
        db.createObjectStore(TVY_DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ═══ Türkçe karakterleri normalize et + slugify ═══
function tvySlugify(isim) {
  return String(isim || '')
    .toLowerCase()
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
    .replace(/\b(tv|hd|sd|fhd|uhd|4k|fullhd|full|tr|türk|turk|turkey)\b/gi, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ═══ JSON Dosyası Yükle (IndexedDB) ═══
async function tvyEpgYukle(file) {
  if (!file) return false;
  try {
    console.log('[TVY-EPG] 📂 Dosya okunuyor:', file.name, '(' + (file.size / 1024 / 1024).toFixed(2) + ' MB)');
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.epg) throw new Error('Geçersiz format — "epg" alanı yok');
    
    const db = await tvyDbAc();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(TVY_DB_STORE, 'readwrite');
      const store = tx.objectStore(TVY_DB_STORE);
      store.put({
        at: Date.now(),
        tarih: data.tarih,
        kanalSayisi: data.kanalSayisi,
        toplamProgram: data.toplamProgram,
        epg: data.epg,
      }, 'main');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    
    tvyData = data.epg;
    const kanalSayisi = Object.keys(tvyData).length;
    const programSayisi = Object.values(tvyData).reduce((s, k) => s + (k.programlar?.length || 0), 0);
    
    console.log('[TVY-EPG] ✅ Yüklendi (IndexedDB):', kanalSayisi, 'kanal,', programSayisi, 'program');
    if (typeof toast === 'function') {
      toast(`✅ EPG yüklendi: ${kanalSayisi} kanal, ${programSayisi} program`, 'success');
    }
    
    // Header ve ayarlar ikonunu güncelle
    if (typeof epgDurumTooltipGuncelle === 'function') epgDurumTooltipGuncelle();
    if (typeof tvyEpgDurumGuncelle === 'function') tvyEpgDurumGuncelle();
    
    return true;
  } catch (e) {
    console.error('[TVY-EPG] ❌ Hata:', e);
    if (typeof toast === 'function') {
      toast('❌ EPG yüklenemedi: ' + e.message, 'error');
    }
    return false;
  }
}

// ═══ EPG Verisini Al (IndexedDB'den) ═══
async function tvyEpgAlAsync() {
  if (tvyData) return tvyData;
  try {
    const db = await tvyDbAc();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(TVY_DB_STORE, 'readonly');
      const req = tx.objectStore(TVY_DB_STORE).get('main');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (result && result.epg) {
      tvyData = result.epg;
      const yasSaat = ((Date.now() - result.at) / 3600000).toFixed(1);
      console.log('[TVY-EPG] 📖 IndexedDB\'den yüklendi (' + yasSaat + ' saat önce)');
      return tvyData;
    }
  } catch (e) {
    console.warn('[TVY-EPG] IndexedDB okuma hatası:', e);
  }
  return null;
}

// ═══ Senkron Erişim (bellek önbelleği) ═══
function tvyEpgAl() {
  return tvyData;
}

// ═══ Uygulama Açılışında Çağır ═══
async function tvyEpgBaslat() {
  await tvyEpgAlAsync();
  if (tvyData) {
    const kanalSayisi = Object.keys(tvyData).length;
    console.log('[TVY-EPG] 🚀 Başlangıçta yüklendi:', kanalSayisi, 'kanal');
  } else {
    console.log('[TVY-EPG] ℹ️ Kayıtlı EPG yok, EPG Eşleştirme sayfasından yükleyin');
  }
  // Header ikonunu güncelle
  if (typeof epgDurumTooltipGuncelle === 'function') {
    setTimeout(() => epgDurumTooltipGuncelle(), 500);
  }
}

// ═══ Kanal Adı ↔ Slug Eşleştir ═══
function tvyEslestir(kanalAdi) {
  const data = tvyEpgAl();
  if (!data) return null;
  
  const hedef = tvySlugify(kanalAdi);
  if (!hedef) return null;
  
  // 1) Tam eşleşme
  if (data[hedef]) return { slug: hedef, ...data[hedef] };
  
  // 2) Prefix eşleşme
  const keys = Object.keys(data);
  const prefixMatch = keys.find(k => 
    k === hedef || 
    k.startsWith(hedef + '-') || 
    hedef.startsWith(k + '-')
  );
  if (prefixMatch) return { slug: prefixMatch, ...data[prefixMatch] };
  
  // 3) Kelime bazlı eşleşme
  const hedefKelimeler = hedef.split('-').filter(w => w.length > 1);
  for (const key of keys) {
    const keyKelimeler = key.split('-');
    const ortak = hedefKelimeler.filter(w => keyKelimeler.includes(w));
    if (ortak.length >= Math.min(2, hedefKelimeler.length)) {
      return { slug: key, ...data[key] };
    }
  }
  
  // 4) Levenshtein
  let enIyi = null, enIyiSkor = 4;
  for (const key of keys) {
    const skor = levenshtein(hedef, key);
    if (skor < enIyiSkor) { enIyiSkor = skor; enIyi = key; }
  }
  if (enIyi) return { slug: enIyi, ...data[enIyi] };
  
  return null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + cost);
    }
  }
  return d[m][n];
}

// ═══ Şu Anki Programı Bul ═══
function tvySuAn(programlar) {
  if (!programlar?.length) return null;
  const now = Date.now();
  return programlar.find(p => {
    const b = new Date(p.baslangic).getTime();
    const s = new Date(p.bitis).getTime();
    return b <= now && s > now;
  }) || null;
}

// ═══ Sonraki Programı Bul ═══
function tvySonraki(programlar) {
  if (!programlar?.length) return null;
  const now = Date.now();
  return programlar
    .filter(p => new Date(p.baslangic).getTime() > now)
    .sort((a, b) => new Date(a.baslangic) - new Date(b.baslangic))[0] || null;
}

function tvySaatFormat(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ═══ Player'da EPG Bar'ı Doldur ═══
function tvyBarGoster(kanalAdi, streamId) {
  const bar = document.getElementById('epgBar');
  if (!bar) return;
  
  let eslesen = null;
  
  if (streamId && typeof loadEPGMatches === 'function') {
    const matches = loadEPGMatches();
    const manuelSlug = matches['tvy_' + streamId];
    const data = tvyEpgAl();
    if (manuelSlug && data && data[manuelSlug]) {
      eslesen = { slug: manuelSlug, ...data[manuelSlug] };
    }
  }
  
  if (!eslesen) eslesen = tvyEslestir(kanalAdi);
  
  bar.style.display = 'block';
  
  if (!eslesen) {
    document.getElementById('epgNowTitle').textContent = 
      `📺 ${kanalAdi || 'Bu kanal'} — yayın akışı bilgisi yok`;
    document.getElementById('epgNowTime').textContent = '';
    document.getElementById('epgNextTitle').textContent = '—';
    document.getElementById('epgNextTime').textContent = '';
    return;
  }
  
  const suAn = tvySuAn(eslesen.programlar);
  const sonraki = tvySonraki(eslesen.programlar);
  
  if (suAn) {
    document.getElementById('epgNowTitle').textContent = suAn.baslik;
    document.getElementById('epgNowTime').textContent = 
      `${tvySaatFormat(suAn.baslangic)} - ${tvySaatFormat(suAn.bitis)}`;
  } else {
    document.getElementById('epgNowTitle').textContent = 'Program bilgisi yok';
    document.getElementById('epgNowTime').textContent = '';
  }
  
  if (sonraki) {
    document.getElementById('epgNextTitle').textContent = sonraki.baslik;
    document.getElementById('epgNextTime').textContent = 
      `${tvySaatFormat(sonraki.baslangic)} - ${tvySaatFormat(sonraki.bitis)}`;
  } else {
    document.getElementById('epgNextTitle').textContent = '—';
    document.getElementById('epgNextTime').textContent = '';
  }
}

// ═══ EPG Durum Bilgisi ═══
async function tvyEpgDurum() {
  try {
    const db = await tvyDbAc();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(TVY_DB_STORE, 'readonly');
      const req = tx.objectStore(TVY_DB_STORE).get('main');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    const yasSaat = ((Date.now() - result.at) / 3600000).toFixed(1);
    const kanalSayisi = Object.keys(result.epg || {}).length;
    const programSayisi = Object.values(result.epg || {}).reduce((s, k) => s + (k.programlar?.length || 0), 0);
    return {
      tarih: result.tarih,
      yasSaat: parseFloat(yasSaat),
      kanalSayisi,
      programSayisi,
      guncel: (Date.now() - result.at) < TVY_CACHE_SURESI,
    };
  } catch(e) { return null; }
}

// ═══ AYARLAR MODALI — EPG DURUM GÖSTER ═══
async function tvyEpgDurumGuncelle() {
  const statusEl = document.getElementById('tvyEpgSettingsStatus');
  const detailEl = document.getElementById('tvyEpgSettingsDetail');
  if (!statusEl || !detailEl) return;
  
  statusEl.textContent = '⏳ Kontrol ediliyor...';
  statusEl.style.color = 'var(--dim)';
  
  const durum = await tvyEpgDurum();
  
  if (!durum) {
    statusEl.textContent = '❌ EPG yüklü değil';
    statusEl.style.color = 'var(--danger)';
    detailEl.textContent = 'EPG Eşleştirme sayfasından JSON yükleyin';
    return;
  }
  
  statusEl.textContent = `✅ ${durum.kanalSayisi} kanal, ${durum.programSayisi} program`;
  statusEl.style.color = 'var(--success)';
  
  if (durum.guncel) {
    detailEl.textContent = `${durum.tarih} tarihli • ${durum.yasSaat.toFixed(1)} saat önce yüklendi`;
    detailEl.style.color = 'var(--dim)';
  } else {
    detailEl.textContent = `⚠️ ${durum.yasSaat.toFixed(0)} saat eski • Güncellemenizi öneririz`;
    detailEl.style.color = 'var(--warning)';
  }
}

// ═══ HEADER EPG DURUM İKONU ═══
async function epgDurumTooltipGuncelle() {
    const el = document.getElementById('epgStatusDot');
    if (!el) return;
    
    const durum = await tvyEpgDurum();
    
    // Kalan gün sayısını hesapla
    let kalanGun = 0;
    if (typeof tvyKalanGunSayisi === 'function') {
        kalanGun = tvyKalanGunSayisi();
    }
    
    // ═══ EPG YOKSA ═══
    if (!durum) {
        el.textContent = '📡 —';
        el.title = '❌ TVY EPG yüklü değil\n\nEPG Eşleştirme sayfasından JSON yükleyin';
        el.style.color = 'var(--dim)';
        return;
    }
    
    // ═══ KALAN GÜNE GÖRE RENK ═══
    let renk;
    let emoji;
    
    if (kalanGun <= 1) {
        renk = 'var(--danger)';   // 🔴 Kırmızı — son gün
        emoji = '🚨';
    } else if (kalanGun <= 3) {
        renk = 'var(--warning)';  // 🟡 Sarı — az kaldı
        emoji = '⚠️';
    } else {
        renk = 'var(--success)';  // 🟢 Yeşil — bol veri var
        emoji = '✅';
    }
    
    // ═══ HEADER METNİ: 📡 216 (6g) ═══
    el.textContent = `📡 ${durum.kanalSayisi} (${kalanGun}g)`;
    el.style.color = renk;
    
    // ═══ TOOLTIP (Fareyle üzerine gelince) ═══
    const tooltipSatirlari = [
        `${emoji} TVY EPG: ${durum.kanalSayisi} kanal, ${durum.programSayisi} program`,
        `📅 Tarih: ${durum.tarih}`,
        `⏱️ Yüklenme: ${durum.yasSaat.toFixed(1)} saat önce`,
        `📊 Kalan: ${kalanGun} gün`,
    ];
    
    // Kalan gün azsa uyarı ekle
    if (kalanGun <= 1) {
        tooltipSatirlari.push('');
        tooltipSatirlari.push('🚨 SON GÜN! Yeni JSON yükleyin!');
    } else if (kalanGun <= 3) {
        tooltipSatirlari.push('');
        tooltipSatirlari.push('⚠️ Yakında güncellenmeli');
    }
    
    el.title = tooltipSatirlari.join('\n');
    
    // ═══ TIKLAMA: EPG Eşleştirme sayfasına git ═══
    if (!el.__tvyClickBound) {
        el.__tvyClickBound = true;
        el.style.cursor = 'pointer';
        el.onclick = () => {
            if (typeof openEPGMatchPage === 'function') {
                openEPGMatchPage();
            }
        };
    }
}

// ═══ AYARLAR MODALI — MANUEL YÜKLEME ═══
function tvyEpgManuelYukle() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ok = await tvyEpgYukle(file);
    if (ok) setTimeout(() => tvyEpgDurumGuncelle(), 500);
    document.body.removeChild(input);
  };
  document.body.appendChild(input);
  input.click();
}

// ═══ EPG TEMİZLE ═══
async function tvyEpgTemizle() {
  if (!confirm('TVY EPG verisi silinsin mi?\n\nSonraki kullanımda tekrar yüklemeniz gerekir.')) return;
  try {
    const db = await tvyDbAc();
    const tx = db.transaction(TVY_DB_STORE, 'readwrite');
    tx.objectStore(TVY_DB_STORE).delete('main');
    tvyData = null;
    tx.oncomplete = () => {
      if (typeof toast === 'function') toast('🗑️ TVY EPG temizlendi', 'success');
      console.log('[TVY-EPG] 🗑️ Veri temizlendi');
      if (typeof tvyEpgDurumGuncelle === 'function') tvyEpgDurumGuncelle();
      if (typeof epgDurumTooltipGuncelle === 'function') epgDurumTooltipGuncelle();
    };
  } catch(e) {
    console.error('[TVY-EPG] Temizleme hatası:', e);
    if (typeof toast === 'function') toast('❌ Temizlenemedi: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════
// BAŞLANGIÇ — Sayfa yüklenince çalışır
// ═══════════════════════════════════════════════════
(function initTVYEpg() {
  function baslat() {
    // 1) EPG verisini belleğe yükle
    tvyEpgBaslat().then(async () => {
      // 2) Günlük otomatik temizlik (günde 1 kez)
      await tvyGunlukTemizlik();
      
      // 3) Header ikonunu güncelle (kalan gün ile)
      await epgDurumTooltipGuncelle();
      
      // 4) Hatırlatıcı (2-4 gün kaldıysa)
      setTimeout(() => tvyEpgHatirlatici(), 3000);
    });
    
    // 5) 6 saatte bir periyodik kontrol
    setInterval(async () => {
      await tvyGunlukTemizlik();
      await epgDurumTooltipGuncelle();
      await tvyEpgHatirlatici();
    }, 6 * 60 * 60 * 1000);
    
    // 6) Header ikonunu 30 dakikada bir güncelle
    setInterval(() => {
      if (typeof epgDurumTooltipGuncelle === 'function') epgDurumTooltipGuncelle();
    }, 30 * 60 * 1000);
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', baslat);
  } else {
    baslat();
  }
})();
// ═══════════════════════════════════════════════════
// A) OTOMATİK FİLTRELEME — Eski programları sil
// ═══════════════════════════════════════════════════
function tvyEskiProgramlariTemizle() {
    if (!tvyData) return { temizlenen: 0, kalan: 0 };
    
    const bugun = new Date();
    bugun.setHours(0, 0, 0, 0);
    const bugunTs = bugun.getTime();
    
    let temizlenen = 0, kalan = 0;
    
    Object.keys(tvyData).forEach(slug => {
        const kanal = tvyData[slug];
        if (!kanal.programlar) return;
        
        const oncekiSayi = kanal.programlar.length;
        
        // Bugünden önceki programları filtrele (bitiş tarihi bugün veya sonrası kalır)
        kanal.programlar = kanal.programlar.filter(p => {
            const bitis = new Date(p.bitis).getTime();
            return bitis >= bugunTs;
        });
        
        temizlenen += (oncekiSayi - kanal.programlar.length);
        kalan += kanal.programlar.length;
    });
    
    console.log(`[TVY-EPG] 🧹 Temizleme: ${temizlenen} eski program silindi, ${kalan} kaldı`);
    return { temizlenen, kalan };
}

// ═══ TEMİZLENMİŞ VERİYİ KAYDET ═══
async function tvyTemizlenmisKaydet() {
    if (!tvyData) return false;
    
    try {
        const db = await tvyDbAc();
        
        // Eski tarih bilgisini koru
        const eski = await new Promise((resolve, reject) => {
            const tx = db.transaction(TVY_DB_STORE, 'readonly');
            const req = tx.objectStore(TVY_DB_STORE).get('main');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        
        await new Promise((resolve, reject) => {
            const tx = db.transaction(TVY_DB_STORE, 'readwrite');
            tx.objectStore(TVY_DB_STORE).put({
                at: eski?.at || Date.now(),
                tarih: eski?.tarih || new Date().toISOString().slice(0,10),
                kanalSayisi: Object.keys(tvyData).length,
                toplamProgram: Object.values(tvyData).reduce((s, k) => s + (k.programlar?.length || 0), 0),
                epg: tvyData,
            }, 'main');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        
        console.log('[TVY-EPG] 💾 Temizlenmiş veri kaydedildi');
        return true;
    } catch(e) {
        console.error('[TVY-EPG] Kaydetme hatası:', e);
        return false;
    }
}

// ═══ GÜNLÜK TEMİZLİK KONTROLÜ ═══
async function tvyGunlukTemizlik() {
    const sonTemizlik = localStorage.getItem('pasham_tvy_son_temizlik');
    const bugun = new Date().toISOString().slice(0, 10);
    
    if (sonTemizlik === bugun) {
        console.log('[TVY-EPG] ✅ Bugün zaten temizlendi');
        return;
    }
    
    if (!tvyData) {
        await tvyEpgAlAsync();
    }
    
    if (!tvyData) return;
    
    console.log('[TVY-EPG] 🧹 Günlük temizlik başlıyor...');
    const sonuc = tvyEskiProgramlariTemizle();
    
    if (sonuc.temizlenen > 0) {
        await tvyTemizlenmisKaydet();
        console.log(`[TVY-EPG] ✅ ${sonuc.temizlenen} eski program silindi`);
    }
    
    localStorage.setItem('pasham_tvy_son_temizlik', bugun);
}

// ═══════════════════════════════════════════════════
// C) KAÇ GÜN KALDI? — Header'da göster
// ═══════════════════════════════════════════════════
function tvyKalanGunSayisi() {
    if (!tvyData) return 0;
    
    let enSonTarih = 0;
    Object.values(tvyData).forEach(kanal => {
        if (!kanal.programlar) return;
        kanal.programlar.forEach(p => {
            const bitis = new Date(p.bitis).getTime();
            if (bitis > enSonTarih) enSonTarih = bitis;
        });
    });
    
    if (!enSonTarih) return 0;
    
    const simdi = Date.now();
    const kalanMs = enSonTarih - simdi;
    return Math.max(0, Math.ceil(kalanMs / (24 * 60 * 60 * 1000)));
}

// ═══════════════════════════════════════════════════
// B) HATIRLATICI — 2-4 gün kaldığında uyar
// ═══════════════════════════════════════════════════
async function tvyEpgHatirlatici() {
    if (!tvyData) return;
    
    const kalanGun = tvyKalanGunSayisi();
    const sonUyari = localStorage.getItem('pasham_tvy_son_uyari');
    const bugun = new Date().toISOString().slice(0, 10);
    
    // Aynı gün tekrar uyarmayalım
    if (sonUyari === bugun) return;
    
    console.log(`[TVY-EPG] 📅 EPG'de ${kalanGun} gün kaldı`);
    
    if (kalanGun <= 2) {
        if (typeof toast === 'function') {
            toast(`🚨 EPG'de sadece ${kalanGun} gün kaldı! Yeni JSON yükleyin`, 'error');
        }
        localStorage.setItem('pasham_tvy_son_uyari', bugun);
    } else if (kalanGun <= 4) {
        if (typeof toast === 'function') {
            toast(`📡 EPG'de ${kalanGun} gün kaldı — yakında güncelleyin`, 'warning');
        }
        localStorage.setItem('pasham_tvy_son_uyari', bugun);
    }
}

// ═══ EPG DURUM GÜNCELLE (Header + Ayarlar) — GÜNCELLENDİ ═══
async function epgDurumTooltipGuncelle() {
  const el = document.getElementById('epgStatusDot');
  if (!el) return;
  
  const durum = await tvyEpgDurum();
  const kalanGun = tvyKalanGunSayisi();
  
  if (!durum) {
    el.textContent = '📡 —';
    el.title = 'TVY EPG yüklü değil — EPG Eşleştirme sayfasından yükleyin';
    el.style.color = 'var(--dim)';
  } else if (durum.guncel) {
    // ✅ Güncel göster — kalan gün sayısıyla
    el.textContent = `📡 ${durum.kanalSayisi} (${kalanGun}g)`;
    el.title = `✅ TVY EPG: ${durum.kanalSayisi} kanal, ${durum.programSayisi} program\n${durum.tarih} • ${durum.yasSaat.toFixed(1)} saat önce yüklendi\n📅 Kalan: ${kalanGun} gün`;
    el.style.color = 'var(--success)';
  } else {
    el.textContent = `📡 ${durum.kanalSayisi} ⚠️`;
    el.title = `⚠️ TVY EPG ${durum.yasSaat.toFixed(0)} saat eski — Güncelleyin\n📅 Kalan: ${kalanGun} gün`;
    el.style.color = 'var(--warning)';
  }
}
console.log('[TVY-EPG] 📦 Modül yüklendi v2.1');
