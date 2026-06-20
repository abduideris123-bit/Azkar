// ═══════════════════════════════════════════════════
// ዚክር — Service Worker v3
// ዋና ዘዴ: SW setTimeout ብቻ ሳይሆን
//   1) SW alarm-chain  — fireZikr() ካበቃ ቀጣዩን ወዲያው ያቀናብራል + IDB timestamp ይቀምጣል
//   2) periodicsync    — Chrome Android "wake up" ምልክት (best-effort)
//   3) activate rearm  — SW ድጋሚ ሲነቃ IDB-ን ያነብ፣ ምን ያህል ጊዜ እንዳለፈ ያሰላ
//   4) fetch rearm     — page request ሲኖር SW ይነቃል፣ ዚክር ቢጠፋ ያስጀምራል
// ═══════════════════════════════════════════════════
const SW_VERSION = 'zikr-sw-v3';
const DB_NAME = 'zikr-sw-db';
const STORE = 'kv';
const PRAYER_LABELS = { Fajr:'ፈጅር', Dhuhr:'ዙህር', Asr:'ዐስር', Maghrib:'መግሪብ', Isha:'ዒሻእ' };

// ── lifecycle ──
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    await self.clients.claim();
    await rearmAll();
  })());
});

// fetch — page ሲከፈት SW ይነቃል → ዚክር ቢቆም ያስጀምራል
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
  // background: missed zikr check
  e.waitUntil(checkMissedZikr());
});

// ═══════════════════════════════════════
// IndexedDB helper
// ═══════════════════════════════════════
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror  = () => rej(r.error);
  });
}
async function idbSet(key, val) {
  try {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = rej;
    });
  } catch(e) {}
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r  = tx.objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  } catch(e) { return null; }
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

// ═══════════════════════════════════════
// ZIKR ENGINE  — alarm-chain pattern
// ═══════════════════════════════════════
let _pool = [], _poolIdx = 0, _zikrTimer = null, _intervalMs = 15*60*1000;

function scheduleNextZikr(ms) {
  if (_zikrTimer) clearTimeout(_zikrTimer);
  if (!ms || ms <= 0) return;
  _intervalMs = ms;
  _zikrTimer = setTimeout(async () => {
    await fireZikr();
    // ── alarm-chain: ቀጣዩን ወዲያው ያቀናብራል ──
    scheduleNextZikr(_intervalMs);
  }, ms);
  // IDB-ላይ "ቀጣይ ጊዜ" ይቀምጣል — rearm ሲሆን ያነባዋል
  const nextAt = Date.now() + ms;
  idbGet('reminderState').then(s => {
    if(s) idbSet('reminderState', Object.assign({}, s, { nextAt, intervalMs: ms, poolIdx: _poolIdx }));
  });
}

async function fireZikr() {
  if (!_pool || !_pool.length) return;
  const z = _pool[_poolIdx % _pool.length]; _poolIdx++;
  const ar = z.arabic || '';
  const title = '📿 ' + (ar.length > 60 ? ar.substring(0,60) + '…' : ar);
  const body  = z.meaning + (z.max > 1 ? ` (×${z.max})` : '');
  try {
    await self.registration.showNotification(title, {
      body,
      tag: 'zikr-reminder',
      renotify: true,
      silent: false,
      vibrate: [200, 80, 200, 80, 400],
      requireInteraction: false,
      icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext y=".9em" font-size="90"%3E%F0%9F%93%BF%3C/text%3E%3C/svg%3E',
      badge:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext y=".9em" font-size="90"%3E%F0%9F%93%BF%3C/text%3E%3C/svg%3E',
      data: { type:'zikr', arabic: ar, meaning: z.meaning }
    });
  } catch(e) {}
  // poolIdx IDB-ላይ አስቀምጥ
  idbGet('reminderState').then(s => {
    if(s) idbSet('reminderState', Object.assign({}, s, { poolIdx: _poolIdx }));
  });
}

// ── ምን ያህል ጊዜ እንዳለፈ ይፈትሻል — ያለፈ ዚክር ካለ ወዲያው ያሳያል ──
async function checkMissedZikr() {
  try {
    const s = await idbGet('reminderState');
    if (!s || !s.enabled || !s.pool || !s.pool.length) return;
    if (!s.nextAt) return;
    const now = Date.now();
    if (now >= s.nextAt) {
      // ያለፈ ዚክር አለ — አሁን ላክ
      if (!_pool.length) {
        _pool = s.pool;
        _poolIdx = s.poolIdx || 0;
        _intervalMs = s.intervalMs || 15*60*1000;
      }
      await fireZikr();
      scheduleNextZikr(_intervalMs);
    }
  } catch(e) {}
}

// ═══════════════════════════════════════
// PRAYER ENGINE
// ═══════════════════════════════════════
let _prayerTimers = [];
function clearPrayerTimers() { _prayerTimers.forEach(clearTimeout); _prayerTimers = []; }

function schedulePrayerTimers(times) {
  clearPrayerTimers();
  if (!times) return;
  const now = new Date();
  Object.keys(PRAYER_LABELS).forEach(key => {
    const t = times[key]; if (!t) return;
    const [h, m] = String(t).split(':').map(Number);
    if (isNaN(h)||isNaN(m)) return;
    const target = new Date(now); target.setHours(h, m, 0, 0);
    const diff = target - now;
    if (diff > 0 && diff < 86400000) {
      _prayerTimers.push(setTimeout(() => firePrayer(key), diff));
    }
  });
}

async function firePrayer(key) {
  try {
    await self.registration.showNotification(`🕌 ${PRAYER_LABELS[key]} ሰዓቱ ደረሰ`, {
      body: 'አሁን ሰላት ስገድ',
      tag: 'prayer-'+key, renotify: true, silent: false,
      vibrate: [400,100,400,100,400],
      requireInteraction: true,
      icon:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext y=".9em" font-size="90"%3E%F0%9F%95%8C%3C/text%3E%3C/svg%3E',
      data: { type:'prayer', key }
    });
  } catch(e) {}
}

// ═══════════════════════════════════════
// FAJR ALARM
// ═══════════════════════════════════════
let _fajrTimer = null;
function scheduleFajrAlarmSW(fajrTime, enabled, offsetMin) {
  if (_fajrTimer) { clearTimeout(_fajrTimer); _fajrTimer = null; }
  if (!enabled || !fajrTime) return;
  const [h, m] = String(fajrTime).split(':').map(Number);
  if (isNaN(h)||isNaN(m)) return;
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m - offsetMin, 0, 0);
  if (target <= now) target.setDate(target.getDate()+1);
  const diff = target - now;
  if (diff > 0 && diff < 86400000) {
    _fajrTimer = setTimeout(async () => {
      try {
        await self.registration.showNotification('🌄 ፈጅር ቀርቦ ነው!', {
          body: `ፈጅር ሰዓቱ ከ ${offsetMin} ደቂቃ ውስጥ ነው — ዝግጁ ሁን`,
          tag:'fajr-alarm', renotify:true, silent:false,
          vibrate:[300,100,300,100,600,100,600],
          requireInteraction: true,
          data:{ type:'fajr' }
        });
      } catch(e) {}
    }, diff);
  }
}

// ═══════════════════════════════════════
// PRAYER STATE REFRESH (ቀን ሲቀየር)
// ═══════════════════════════════════════
async function refreshPrayerStateIfStale(state) {
  if (!state || state.date === todayKey() || !state.lat || !state.lng) return state;
  try {
    const d = new Date();
    const url = `https://api.aladhan.com/v1/timings/${d.getDate()}-${d.getMonth()+1}-${d.getFullYear()}?latitude=${state.lat}&longitude=${state.lng}&method=3`;
    const res  = await fetch(url);
    const data = await res.json();
    if (data.code === 200) {
      state.times = data.data.timings;
      state.date  = todayKey();
      await idbSet('prayerState', state);
    }
  } catch(e) {}
  return state;
}

// ═══════════════════════════════════════
// REARM ALL — SW ሲነቃ / periodicsync ሲሆን
// ═══════════════════════════════════════
async function rearmAll() {
  // 1) zikr reminder
  try {
    const s = await idbGet('reminderState');
    if (s && s.enabled && s.pool && s.pool.length) {
      _pool       = s.pool;
      _poolIdx    = s.poolIdx || 0;
      _intervalMs = s.intervalMs || 15*60*1000;

      // ያለፈ ዚክር ካለ ወዲያው ላክ
      const now = Date.now();
      if (s.nextAt && now >= s.nextAt) {
        await fireZikr();
        scheduleNextZikr(_intervalMs);
      } else {
        // ቀሪ ጊዜ አሰላ
        const remaining = s.nextAt ? Math.max(s.nextAt - now, 1000) : _intervalMs;
        scheduleNextZikr(remaining);
      }
    }
  } catch(e) {}

  // 2) prayer timers
  try {
    let prayer = await idbGet('prayerState');
    if (prayer) {
      prayer = await refreshPrayerStateIfStale(prayer);
      schedulePrayerTimers(prayer.times);
    }
  } catch(e) {}

  // 3) fajr alarm
  try {
    const fs = await idbGet('fajrAlarmState');
    if (fs && fs.enabled && fs.fajrTime)
      scheduleFajrAlarmSW(fs.fajrTime, true, fs.offsetMin || 15);
  } catch(e) {}
}

// ═══════════════════════════════════════
// MESSAGES ከ page
// ═══════════════════════════════════════
self.addEventListener('message', e => {
  if (!e.data) return;
  const d = e.data;

  if (d.type === 'START_REMINDER') {
    if (d.pool && d.pool.length) { _pool = d.pool; _poolIdx = 0; }
    _intervalMs = d.intervalMs || 15*60*1000;
    scheduleNextZikr(_intervalMs);
    idbSet('reminderState', {
      enabled: true, intervalMs: _intervalMs,
      pool: _pool, poolIdx: 0,
      nextAt: Date.now() + _intervalMs
    });
  }

  if (d.type === 'STOP_REMINDER') {
    if (_zikrTimer) { clearTimeout(_zikrTimer); _zikrTimer = null; }
    idbGet('reminderState').then(s =>
      idbSet('reminderState', Object.assign({}, s, { enabled: false }))
    );
  }

  if (d.type === 'UPDATE_POOL') {
    _pool = d.pool || []; _poolIdx = 0;
    idbGet('reminderState').then(s =>
      idbSet('reminderState', Object.assign({}, s, { pool: _pool, poolIdx: 0 }))
    );
  }

  if (d.type === 'SCHEDULE_PRAYERS') {
    schedulePrayerTimers(d.times);
    idbSet('prayerState', { times: d.times, date: d.date, lat: d.lat, lng: d.lng });
  }

  if (d.type === 'FAJR_ALARM') {
    scheduleFajrAlarmSW(d.fajrTime, d.enabled, d.offsetMin || 15);
    idbSet('fajrAlarmState', { fajrTime: d.fajrTime, enabled: d.enabled, offsetMin: d.offsetMin || 15 });
  }

  // PING — page ሲከፈት SW ንቁ ነው ወይ ይፈትሻል
  if (d.type === 'PING') {
    checkMissedZikr();
  }
});

// ═══════════════════════════════════════
// PERIODIC BACKGROUND SYNC
// ═══════════════════════════════════════
self.addEventListener('periodicsync', e => {
  if (e.tag === 'zikr-rearm') e.waitUntil(rearmAll());
});
self.addEventListener('sync', e => {
  e.waitUntil(rearmAll());
});

// ═══════════════════════════════════════
// NOTIFICATION CLICK
// ═══════════════════════════════════════
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(cs => {
      for (const c of cs) if ('focus' in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow('.');
    })
  );
});
