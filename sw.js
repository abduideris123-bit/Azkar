// ═══════════════════════════════════════════════════
// ዚክር — Service Worker
// የበስተጀርባ (background) ማስታወቂያ ለ: 1) የሰላት ሰዓት  2) የዚክር ማስታወሻ
// ═══════════════════════════════════════════════════
const SW_VERSION = 'zikr-sw-v1';
const DB_NAME = 'zikr-sw-db';
const STORE = 'kv';
const PRAYER_LABELS = { Fajr: 'ፈጅር', Dhuhr: 'ዙህር', Asr: 'ዐስር', Maghrib: 'መግሪብ', Isha: 'ዒሻእ' };

// ── lifecycle ──
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // SW በድጋሚ ሲነቃ (browser ካስቆመው በኋላ) ከ IndexedDB ተመልሶ ራሱ ይታደሳል
  e.waitUntil((async () => {
    await self.clients.claim();
    await rearmAll();
  })());
});

// app offline ሆኖ እንዲከፈት — ቀላል pass-through
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ═══════════════════════════════════════
// ትንሽ IndexedDB key-value helper
// (SW ድንገት ሲቆም/ሲጠፋ እንኳ መረጃው ስለሚቀመጥ መልሶ መጀመር ይችላል)
// ═══════════════════════════════════════
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return null; }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// ═══════════════════════════════════════
// የዚክር ማስታወሻ ENGINE
// ═══════════════════════════════════════
let _pool = [], _poolIdx = 0, _zikrTimer = null;

function scheduleNextZikr(ms) {
  if (_zikrTimer) clearTimeout(_zikrTimer);
  if (!ms || ms <= 0) return;
  _zikrTimer = setTimeout(() => { fireZikr(); scheduleNextZikr(ms); }, ms);
}
function fireZikr() {
  if (!_pool || !_pool.length) return;
  const z = _pool[_poolIdx % _pool.length]; _poolIdx++;
  const ar = z.arabic || '';
  const title = '📿 ' + (ar.length > 70 ? ar.substring(0, 70) + '…' : ar);
  const body = z.meaning + (z.max > 1 ? ' ×' + z.max : '');
  self.registration.showNotification(title, {
    body,
    tag: 'zikr-reminder',
    renotify: true,
    silent: false,
    vibrate: [250, 100, 250, 100, 500],
    requireInteraction: false,
    data: { type: 'zikr', arabic: ar, meaning: z.meaning }
  }).catch(() => {});
}

// ═══════════════════════════════════════
// የሰላት ሰዓት ማስታወሻ ENGINE
// ═══════════════════════════════════════
let _prayerTimers = [];

function clearPrayerTimers() {
  _prayerTimers.forEach(id => clearTimeout(id));
  _prayerTimers = [];
}

function schedulePrayerTimers(times) {
  clearPrayerTimers();
  if (!times) return;
  const now = new Date();
  Object.keys(PRAYER_LABELS).forEach(key => {
    const t = times[key]; if (!t) return;
    const [h, m] = String(t).split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return;
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    const diff = target - now;
    if (diff > 0 && diff < 86400000) {
      const id = setTimeout(() => firePrayer(key), diff);
      _prayerTimers.push(id);
    }
  });
}

function firePrayer(key) {
  self.registration.showNotification(`🕌 ${PRAYER_LABELS[key] || key} ሰዓቱ ደረሰ`, {
    body: 'ሰዓቱን ጠብቅ — ሰላት ቀርቦ ነው',
    tag: 'prayer-' + key,
    renotify: true,
    silent: false,
    vibrate: [300, 100, 300],
    requireInteraction: false,
    data: { type: 'prayer', key }
  }).catch(() => {});
}

// ቀኑ ሲቀየር (ለምሳሌ አፑ ሌሊቱን ሙሉ ሳይከፈት ቢቆይ) SW ራሱ ከ Aladhan API አዲስ ሰዓት ይፈልጋል
async function refreshPrayerStateIfStale(state) {
  if (!state) return state;
  if (state.date === todayKey()) return state;
  if (!state.lat || !state.lng) return state;
  try {
    const d = new Date();
    const url = `https://api.aladhan.com/v1/timings/${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}?latitude=${state.lat}&longitude=${state.lng}&method=3`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 200) {
      state.times = data.data.timings;
      state.date = todayKey();
      await idbSet('prayerState', state);
    }
  } catch (e) {}
  return state;
}

// ═══════════════════════════════════════
// ራስን-ማደስ (self-heal) — SW ድጋሚ ሲነቃ ይጠራል
// ═══════════════════════════════════════
async function rearmAll() {
  try {
    const reminder = await idbGet('reminderState');
    if (reminder && reminder.enabled && reminder.pool && reminder.pool.length) {
      _pool = reminder.pool;
      _poolIdx = reminder.poolIdx || 0;
      scheduleNextZikr(reminder.intervalMs || 15 * 60 * 1000);
    }
  } catch (e) {}

  try {
    let prayer = await idbGet('prayerState');
    if (prayer) {
      prayer = await refreshPrayerStateIfStale(prayer);
      schedulePrayerTimers(prayer.times);
    }
  } catch (e) {}
}

// ═══════════════════════════════════════
// ከገጹ (page) የሚመጡ መልዕክቶች
// ═══════════════════════════════════════
self.addEventListener('message', (e) => {
  if (!e.data) return;
  const d = e.data;

  if (d.type === 'START_REMINDER') {
    if (d.pool && d.pool.length) { _pool = d.pool; _poolIdx = 0; }
    scheduleNextZikr(d.intervalMs);
    idbSet('reminderState', { enabled: true, intervalMs: d.intervalMs, pool: _pool, poolIdx: _poolIdx });
  }

  if (d.type === 'STOP_REMINDER') {
    if (_zikrTimer) { clearTimeout(_zikrTimer); _zikrTimer = null; }
    idbGet('reminderState').then(s => {
      idbSet('reminderState', Object.assign({}, s, { enabled: false }));
    });
  }

  if (d.type === 'UPDATE_POOL') {
    _pool = d.pool || []; _poolIdx = 0;
    idbGet('reminderState').then(s => {
      idbSet('reminderState', Object.assign({}, s, { pool: _pool, poolIdx: 0 }));
    });
  }

  if (d.type === 'SCHEDULE_PRAYERS') {
    const state = { times: d.times, date: d.date, lat: d.lat, lng: d.lng, city: d.city };
    schedulePrayerTimers(d.times);
    idbSet('prayerState', state);
  }
});

// ═══════════════════════════════════════
// Periodic Background Sync — best-effort "ንቃ" ምልክት
// (ስልኩ/browser ሲደግፈው ብቻ ይሰራል — ካልደገፈም ምንም አይጎዳም)
// ═══════════════════════════════════════
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'zikr-rearm') {
    e.waitUntil(rearmAll());
  }
});
self.addEventListener('sync', (e) => {
  e.waitUntil(rearmAll());
});

// ═══════════════════════════════════════
// ማስታወቂያ ሲጫን — አፑን ክፈት/ፎከስ አድርግ
// ═══════════════════════════════════════
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('.');
  }));
});
