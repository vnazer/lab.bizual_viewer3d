// IndexedDB store for the user's custom-uploaded HDRI.
// localStorage tops out at ~5MB and is text-only — a 2K HDR is ~4MB binary.
// We persist the raw ArrayBuffer here and a small flag in localStorage so
// boot-up can decide quickly whether to bother opening the DB.

const DB_NAME = 'BizualLab';
const DB_VERSION = 1;
const STORE = 'hdri';
const FLAG_KEY = 'bizual_lab_hdri_is_custom';
const NAME_KEY = 'bizual_lab_hdri_custom_name';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustomHDRI(arrayBuffer, filename) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key: 'custom', data: arrayBuffer, name: filename });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  localStorage.setItem(FLAG_KEY, '1');
  localStorage.setItem(NAME_KEY, filename);
  db.close();
}

export async function loadCustomHDRI() {
  if (!localStorage.getItem(FLAG_KEY)) return null;
  let db;
  try { db = await openDB(); } catch { return null; }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get('custom');
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror   = () => { db.close(); resolve(null); };
  });
}

export async function clearCustomHDRI() {
  let db;
  try { db = await openDB(); } catch { /* ignore */ }
  if (db) {
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('custom');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    db.close();
  }
  localStorage.removeItem(FLAG_KEY);
  localStorage.removeItem(NAME_KEY);
}

export function getCustomHDRIName() {
  return localStorage.getItem(NAME_KEY);
}

export function hasCustomHDRI() {
  return !!localStorage.getItem(FLAG_KEY);
}
