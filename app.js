'use strict';

/* =========================================================
   Soundboard – Web-App fürs iPhone
   Sounds werden lokal in IndexedDB gespeichert, Wiedergabe
   über die Web Audio API (geringe Latenz).
   ========================================================= */

const APP_VERSION = '1.0.1';
const DB_NAME = 'soundboard';
const STORE = 'tiles';
const MAX_REC_MS = 2 * 60 * 1000; // max. 2 Minuten Aufnahme
const MAX_FILE_BYTES = 30 * 1024 * 1024;

const COLORS = [
  '#ff4d4f', '#ff8a3d', '#ffc53d', '#73d13d', '#22c3a6', '#36cfc9',
  '#40a9ff', '#2f54eb', '#9254de', '#f759ab', '#8c8c8c', '#5c6b7a'
];
const EMOJIS = [
  '😂', '🤣', '😱', '😎', '🙈', '👏', '🎉', '🥳',
  '💥', '🔥', '🚨', '🔔', '📣', '📯', '🎺', '🥁',
  '🎸', '🎹', '🎤', '🎵', '⏰', '🚒', '🚓', '🚀',
  '🐶', '🐱', '🐮', '🐔', '🦆', '🐸', '🤖', '👻',
  '💩', '❤️', '⭐', '✅', '❌', '❓', '👍', '👎'
];

const $ = (sel) => document.querySelector(sel);
const el = {
  board: $('#board'), empty: $('#empty'), emptyAdd: $('#emptyAdd'),
  editBtn: $('#editBtn'), menuBtn: $('#menuBtn'),
  nowBar: $('#nowBar'), nowEmoji: $('#nowEmoji'), nowName: $('#nowName'),
  nowStop: $('#nowStop'), nowProgress: $('#nowProgress'),
  editor: $('#editor'), edTitle: $('#edTitle'), edCancel: $('#edCancel'), edSave: $('#edSave'),
  edPreview: $('#edPreview'), edName: $('#edName'), edSoundInfo: $('#edSoundInfo'),
  edRec: $('#edRec'), edFile: $('#edFile'), edPlay: $('#edPlay'),
  edEmoji: $('#edEmoji'), edEmojiClear: $('#edEmojiClear'), edEmojiGrid: $('#edEmojiGrid'),
  edColors: $('#edColors'), edDelete: $('#edDelete'),
  menu: $('#menu'),
  dialog: $('#dialog'), dlgTitle: $('#dlgTitle'), dlgText: $('#dlgText'), dlgBtns: $('#dlgBtns'),
  toast: $('#toast'),
  audioFile: $('#audioFile'), backupFile: $('#backupFile')
};

/* ---------------- Hilfsfunktionen ---------------- */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.45;
}

function firstGrapheme(s) {
  s = (s || '').trim();
  if (!s) return '';
  if (window.Intl && Intl.Segmenter) {
    const it = new Intl.Segmenter('de', { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
    return it.value ? it.value.segment : '';
  }
  return Array.from(s).slice(0, 2).join('');
}

function fmtSeconds(sec) {
  return sec.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function abToB64(ab) {
  const bytes = new Uint8Array(ab);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
function b64ToAb(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2400);
}

/* ---------------- IndexedDB ---------------- */

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}
async function dbPutMany(list) {
  const db = await openDB();
  const t = db.transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  list.forEach((item) => s.put(item));
  return txDone(t);
}
async function dbDelete(id) {
  const db = await openDB();
  const t = db.transaction(STORE, 'readwrite');
  t.objectStore(STORE).delete(id);
  return txDone(t);
}
async function dbClear() {
  const db = await openDB();
  const t = db.transaction(STORE, 'readwrite');
  t.objectStore(STORE).clear();
  return txDone(t);
}

let persistAsked = false;
function requestPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* egal */ }
}

/* ---------------- Audio ---------------- */

let ctx = null;
const buffers = new Map();   // tileId -> AudioBuffer
const decoding = new Map();  // tileId -> Promise
const undecodable = new Set(); // tileIds, die nur per <audio> abspielbar sind

function setSession(type) {
  // Safari 16.4+: 'playback' ignoriert den Lautlos-Schalter
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* nicht unterstützt */ }
}

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}
function resetCtx() {
  // Nach einer Aufnahme neu anlegen, damit iOS wieder über den Lautsprecher (laut) ausgibt
  if (ctx) { try { ctx.close(); } catch (e) { /* egal */ } }
  ctx = null;
}

function decode(ab) {
  const c = getCtx();
  return new Promise((resolve, reject) => {
    // slice(): decodeAudioData "verbraucht" den Buffer
    const p = c.decodeAudioData(ab.slice(0), resolve, reject);
    if (p && p.catch) p.catch(() => {});
  });
}

function decodeTile(t) {
  if (!t.audio) return Promise.resolve(null);
  if (buffers.has(t.id)) return Promise.resolve(buffers.get(t.id));
  if (decoding.has(t.id)) return decoding.get(t.id);
  if (undecodable.has(t.id)) return Promise.resolve(null);
  const p = decode(t.audio)
    .then((b) => { buffers.set(t.id, b); return b; })
    .catch(() => { undecodable.add(t.id); return null; })
    .finally(() => decoding.delete(t.id));
  decoding.set(t.id, p);
  return p;
}

let current = null;   // { id, name, emoji, stop(), progress() }
let playToken = 0;
let rafId = 0;

function stopPlayback() {
  playToken++;
  if (current) {
    const c = current;
    current = null;
    try { c.stop(); } catch (e) { /* egal */ }
  }
  updatePlayingUI();
}

function playBuffer(id, buffer, meta) {
  const c = getCtx();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  const startAt = c.currentTime;
  src.start(0);
  const entry = {
    id,
    name: meta.name,
    emoji: meta.emoji,
    stop: () => { try { src.stop(); } catch (e) { /* schon beendet */ } src.disconnect(); },
    progress: () => Math.min(1, (c.currentTime - startAt) / buffer.duration)
  };
  src.onended = () => {
    if (current === entry) { current = null; updatePlayingUI(); }
  };
  current = entry;
  updatePlayingUI();
}

function playViaElement(id, ab, mime, meta) {
  // Fallback, falls Web Audio das Format nicht dekodieren kann
  const url = URL.createObjectURL(new Blob([ab], { type: mime || 'audio/mp4' }));
  const a = new Audio(url);
  const cleanup = () => URL.revokeObjectURL(url);
  const entry = {
    id, name: meta.name, emoji: meta.emoji,
    stop: () => { a.pause(); cleanup(); },
    progress: () => (a.duration ? a.currentTime / a.duration : 0)
  };
  a.onended = () => { cleanup(); if (current === entry) { current = null; updatePlayingUI(); } };
  current = entry;
  a.play().catch(() => { if (current === entry) { current = null; updatePlayingUI(); toast('Sound kann nicht abgespielt werden'); } });
  updatePlayingUI();
}

async function playTile(t) {
  stopPlayback();
  const token = playToken;
  // resume() muss synchron im Tipp-Handler passieren (iOS)
  const c = getCtx();
  if (c.state !== 'running') c.resume().catch(() => {});
  const buf = buffers.get(t.id) || await decodeTile(t);
  if (token !== playToken) return;
  if (buf) playBuffer(t.id, buf, t);
  else playViaElement(t.id, t.audio, t.mime, t);
}

function togglePlay(t) {
  if (current && current.id === t.id) { stopPlayback(); return; }
  if (!t.audio) { toast('Noch kein Sound – über „Bearbeiten“ hinzufügen'); return; }
  playTile(t);
}

function updatePlayingUI() {
  el.board.querySelectorAll('.tile.playing').forEach((n) => {
    n.classList.remove('playing');
    n.style.removeProperty('--p');
  });
  const showBar = current && current.id !== '__draft';
  if (current) {
    const n = el.board.querySelector('.tile[data-id="' + CSS.escape(current.id) + '"]');
    if (n) n.classList.add('playing');
  }
  if (showBar) {
    el.nowEmoji.textContent = current.emoji || '🔊';
    el.nowName.textContent = current.name || 'Sound';
  }
  el.nowBar.classList.toggle('show', !!showBar);
  el.nowBar.setAttribute('aria-hidden', showBar ? 'false' : 'true');
  if (current && !rafId) rafId = requestAnimationFrame(tick);
  updateEditorPlayBtn();
}

function tick() {
  rafId = 0;
  if (!current) { el.nowProgress.style.transform = 'scaleX(0)'; return; }
  const p = current.progress();
  const n = el.board.querySelector('.tile.playing');
  if (n) n.style.setProperty('--p', p);
  el.nowProgress.style.transform = 'scaleX(' + p + ')';
  rafId = requestAnimationFrame(tick);
}

// iOS: AudioContext bei jeder Berührung aufwecken, falls unterbrochen
['touchend', 'click'].forEach((ev) => {
  document.addEventListener(ev, () => {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }, { passive: true, capture: true });
});

/* ---------------- Daten & Darstellung ---------------- */

let tiles = [];
let editMode = false;

function tileById(id) { return tiles.find((t) => t.id === id); }

function fillTile(node, t) {
  node.style.setProperty('--c', t.color);
  node.classList.toggle('light', isLight(t.color));
  node.classList.toggle('noemoji', !t.emoji);
  node.querySelector('.emoji').textContent = t.emoji || '';
  node.querySelector('.name').textContent = t.name || (t.emoji ? '' : 'Ohne Namen');
}

function makeTile(t) {
  const b = document.createElement('button');
  b.className = 'tile';
  b.dataset.id = t.id;
  b.innerHTML =
    '<span class="emoji"></span><span class="name"></span>' +
    (t.audio ? '' : '<span class="sub">kein Sound</span>') +
    '<span class="progress"></span>' +
    '<span class="handle" aria-label="Verschieben">⠿</span>' +
    '<span class="edit-badge">✎</span>';
  fillTile(b, t);
  if (!t.audio) b.classList.add('nosound');
  return b;
}

function render() {
  el.board.textContent = '';
  const frag = document.createDocumentFragment();
  tiles.forEach((t) => frag.appendChild(makeTile(t)));
  if (editMode) {
    const add = document.createElement('button');
    add.className = 'tile add';
    add.setAttribute('aria-label', 'Neue Taste');
    add.textContent = '+';
    frag.appendChild(add);
  }
  el.board.appendChild(frag);
  el.empty.hidden = !(tiles.length === 0 && !editMode);
  document.body.classList.toggle('editing', editMode);
  el.editBtn.textContent = editMode ? 'Fertig' : 'Bearbeiten';
  updatePlayingUI();
}

function setEditMode(on) {
  editMode = on;
  if (on) stopPlayback();
  render();
}

el.editBtn.addEventListener('click', () => setEditMode(!editMode));
el.emptyAdd.addEventListener('click', () => { setEditMode(true); openEditor(null); });
el.nowStop.addEventListener('click', stopPlayback);

el.board.addEventListener('click', (e) => {
  const node = e.target.closest('.tile');
  if (!node) return;
  if (node.classList.contains('add')) { openEditor(null); return; }
  if (e.target.closest('.handle')) return;
  const t = tileById(node.dataset.id);
  if (!t) return;
  if (editMode) openEditor(t);
  else togglePlay(t);
});

/* ---------------- Drag & Drop (Bearbeiten-Modus) ---------------- */

let drag = null;

el.board.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.handle');
  if (!handle || !editMode || drag) return;
  const node = handle.closest('.tile');
  e.preventDefault();
  const r = node.getBoundingClientRect();
  const ghost = node.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.style.width = r.width + 'px';
  ghost.style.height = r.height + 'px';
  ghost.style.left = r.left + 'px';
  ghost.style.top = r.top + 'px';
  document.body.appendChild(ghost);
  node.classList.add('placeholder');
  drag = {
    node, ghost, pointerId: e.pointerId,
    offX: e.clientX - r.left, offY: e.clientY - r.top,
    x: e.clientX, y: e.clientY, moved: false, raf: 0
  };
  try { handle.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
  drag.raf = requestAnimationFrame(dragLoop);
});

window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.ghost.style.left = (drag.x - drag.offX) + 'px';
  drag.ghost.style.top = (drag.y - drag.offY) + 'px';
  reorderAt(drag.x, drag.y);
}, { passive: false });

function reorderAt(x, y) {
  const under = document.elementFromPoint(x, y);
  const target = under && under.closest('.board .tile:not(.add):not(.placeholder)');
  if (!target) return;
  const list = Array.from(el.board.querySelectorAll('.tile:not(.add)'));
  const from = list.indexOf(drag.node);
  const to = list.indexOf(target);
  if (from < 0 || to < 0 || from === to) return;
  if (to > from) target.after(drag.node); else target.before(drag.node);
  drag.moved = true;
}

function dragLoop() {
  if (!drag) return;
  const edge = 90;
  let dy = 0;
  if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 8);
  else if (drag.y > window.innerHeight - edge) dy = Math.ceil((drag.y - (window.innerHeight - edge)) / 8);
  if (dy) { window.scrollBy(0, dy); reorderAt(drag.x, drag.y); }
  drag.raf = requestAnimationFrame(dragLoop);
}

async function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pointerId)) return;
  const d = drag;
  drag = null;
  cancelAnimationFrame(d.raf);
  d.ghost.remove();
  d.node.classList.remove('placeholder');
  if (!d.moved) return;
  const ids = Array.from(el.board.querySelectorAll('.tile[data-id]')).map((n) => n.dataset.id);
  const map = new Map(tiles.map((t) => [t.id, t]));
  tiles = ids.map((id, i) => { const t = map.get(id); t.order = i; return t; });
  try { await dbPutMany(tiles); } catch (err) { toast('Reihenfolge konnte nicht gespeichert werden'); }
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

/* ---------------- Overlays & Dialoge ---------------- */

function openOverlay(o) {
  o.classList.add('open');
  o.setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
}
function closeOverlay(o) {
  o.classList.remove('open');
  o.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.overlay.open')) document.body.classList.remove('locked');
}

function dialog({ title, text, html, buttons }) {
  return new Promise((resolve) => {
    el.dlgTitle.textContent = title || '';
    if (html) el.dlgText.innerHTML = html; else el.dlgText.textContent = text || '';
    el.dlgBtns.textContent = '';
    (buttons || [{ label: 'OK', value: true }]).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.style || '');
      btn.textContent = b.label;
      btn.addEventListener('click', () => { closeOverlay(el.dialog); resolve(b.value); });
      el.dlgBtns.appendChild(btn);
    });
    openOverlay(el.dialog);
  });
}

/* ---------------- Editor ---------------- */

let draft = null;        // Arbeitskopie der Taste
let draftBuffer = null;  // dekodierter Sound der Arbeitskopie
let isNew = false;
let rec = null;          // laufende Aufnahme

function buildEditorStatic() {
  EMOJIS.forEach((em) => {
    const b = document.createElement('button');
    b.textContent = em;
    b.dataset.emoji = em;
    el.edEmojiGrid.appendChild(b);
  });
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.style.setProperty('--c', c);
    b.dataset.color = c;
    b.setAttribute('aria-label', 'Farbe ' + c);
    el.edColors.appendChild(b);
  });
}

async function openEditor(t) {
  stopPlayback();
  isNew = !t;
  if (t) {
    draft = { ...t };
  } else {
    draft = {
      id: uid(), name: '', emoji: '',
      color: COLORS[tiles.length % COLORS.length],
      order: tiles.length, audio: null, mime: '', duration: 0, source: ''
    };
  }
  draft.audioChanged = false;
  draftBuffer = null;
  el.edTitle.textContent = isNew ? 'Neue Taste' : 'Taste bearbeiten';
  el.edName.value = draft.name;
  el.edEmoji.value = draft.emoji;
  el.edDelete.hidden = isNew;
  updateEditorUI();
  openOverlay(el.editor);
  if (t && t.audio) {
    const id = t.id;
    const b = await decodeTile(t);
    if (draft && draft.id === id && !draft.audioChanged) { draftBuffer = b; updateEditorUI(); }
  }
}

function updateEditorUI() {
  if (!draft) return;
  fillTile(el.edPreview, draft);
  el.edEmojiGrid.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.emoji === draft.emoji));
  el.edColors.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.color === draft.color));
  const recording = !!rec;
  if (recording) {
    el.edSoundInfo.textContent = 'Aufnahme läuft …';
    el.edSoundInfo.classList.add('has');
  } else if (draft.audio) {
    const kind = draft.source === 'Datei' ? 'Datei' : 'Aufnahme';
    el.edSoundInfo.textContent = (draft.audioChanged ? 'Neu: ' : '') + kind + (draft.duration ? ' · ' + fmtSeconds(draft.duration) : '');
    el.edSoundInfo.classList.add('has');
  } else {
    el.edSoundInfo.textContent = 'Noch kein Sound';
    el.edSoundInfo.classList.remove('has');
  }
  el.edRec.classList.toggle('recording', recording);
  if (!recording) el.edRec.textContent = '● Aufnehmen';
  el.edFile.disabled = recording;
  el.edSave.disabled = recording;
  el.edCancel.disabled = false;
  updateEditorPlayBtn();
}

function updateEditorPlayBtn() {
  if (!draft) return;
  const playingDraft = current && current.id === '__draft';
  el.edPlay.textContent = playingDraft ? '■ Stopp' : '▶ Anhören';
  el.edPlay.disabled = !!rec || !draft.audio;
}

function closeEditor() {
  if (rec) stopRecording(true);
  stopPlayback();
  closeOverlay(el.editor);
  el.edName.blur();
  el.edEmoji.blur();
  draft = null;
  draftBuffer = null;
}

el.edName.addEventListener('input', () => {
  if (!draft) return;
  draft.name = el.edName.value;
  fillTile(el.edPreview, draft);
});
el.edName.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.edName.blur(); });

el.edEmoji.addEventListener('input', () => {
  if (!draft) return;
  const g = firstGrapheme(el.edEmoji.value);
  draft.emoji = g;
  if (el.edEmoji.value !== g) el.edEmoji.value = g;
  updateEditorUI();
});
el.edEmoji.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.edEmoji.blur(); });
el.edEmojiClear.addEventListener('click', () => {
  if (!draft) return;
  draft.emoji = '';
  el.edEmoji.value = '';
  updateEditorUI();
});
el.edEmojiGrid.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !draft) return;
  draft.emoji = b.dataset.emoji;
  el.edEmoji.value = draft.emoji;
  updateEditorUI();
});
el.edColors.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !draft) return;
  draft.color = b.dataset.color;
  updateEditorUI();
});

el.editor.addEventListener('click', (e) => { if (e.target === el.editor && !rec) closeEditor(); });
el.edCancel.addEventListener('click', closeEditor);

el.edSave.addEventListener('click', async () => {
  if (!draft || rec) return;
  const d = draft;
  const name = el.edName.value.trim();
  const tile = {
    id: d.id,
    name: name || (d.emoji ? '' : 'Sound ' + (tiles.length + (isNew ? 1 : 0))),
    emoji: d.emoji,
    color: d.color,
    order: d.order,
    audio: d.audio,
    mime: d.mime,
    duration: d.duration,
    source: d.source
  };
  try {
    await dbPutMany([tile]);
  } catch (err) {
    dialog({ title: 'Speichern fehlgeschlagen', text: 'Möglicherweise ist der Speicher voll. (' + (err && err.name || err) + ')' });
    return;
  }
  if (d.audioChanged) {
    buffers.delete(tile.id);
    undecodable.delete(tile.id);
    if (!draftBuffer) undecodable.add(tile.id);
    if (draftBuffer) buffers.set(tile.id, draftBuffer);
  }
  const i = tiles.findIndex((t) => t.id === tile.id);
  if (i >= 0) tiles[i] = tile; else tiles.push(tile);
  requestPersist();
  closeEditor();
  render();
});

el.edDelete.addEventListener('click', async () => {
  if (!draft) return;
  const label = draft.name || draft.emoji || 'diese Taste';
  const ok = await dialog({
    title: 'Taste löschen?',
    text: '„' + label + '“ und der Sound werden entfernt.',
    buttons: [
      { label: 'Löschen', value: true, style: 'danger solid' },
      { label: 'Abbrechen', value: false, style: 'cancel' }
    ]
  });
  if (!ok || !draft) return;
  const id = draft.id;
  try { await dbDelete(id); } catch (err) { toast('Löschen fehlgeschlagen'); return; }
  tiles = tiles.filter((t) => t.id !== id);
  buffers.delete(id);
  tiles.forEach((t, i) => { t.order = i; });
  dbPutMany(tiles).catch(() => {});
  closeEditor();
  render();
});

el.edPlay.addEventListener('click', () => {
  if (!draft || !draft.audio) return;
  if (current && current.id === '__draft') { stopPlayback(); return; }
  stopPlayback();
  const c = getCtx();
  if (c.state !== 'running') c.resume().catch(() => {});
  if (draftBuffer) playBuffer('__draft', draftBuffer, draft);
  else playViaElement('__draft', draft.audio, draft.mime, draft);
});

el.edFile.addEventListener('click', () => el.audioFile.click());

el.audioFile.addEventListener('change', async () => {
  const f = el.audioFile.files && el.audioFile.files[0];
  el.audioFile.value = '';
  if (!f || !draft) return;
  if (f.size > MAX_FILE_BYTES) { toast('Datei zu groß (max. 30 MB)'); return; }
  let ab;
  try { ab = await f.arrayBuffer(); } catch (err) {
    dialog({ title: 'Datei nicht lesbar', text: 'Die Datei konnte nicht geöffnet werden. Liegt sie in iCloud? Dann in der Dateien-App einmal antippen, damit sie heruntergeladen wird.' });
    return;
  }
  const ok = await applyDraftAudio(ab, mimeFor(f), 'Datei', f.name);
  if (ok && !el.edName.value.trim()) {
    el.edName.value = f.name.replace(/\.[^.]+$/, '').slice(0, 30);
    draft.name = el.edName.value;
    updateEditorUI();
  }
});

const EXT_MIME = {
  m4a: 'audio/mp4', m4b: 'audio/mp4', m4r: 'audio/mp4', mp4: 'audio/mp4', '3gp': 'audio/3gpp',
  aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', caf: 'audio/x-caf',
  aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm'
};
function mimeFor(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  // Endung hat Vorrang: iOS meldet bei m4a teils "audio/x-m4a" oder gar keinen Typ
  return EXT_MIME[ext] || f.type || 'audio/mp4';
}

// Fallback: Format über das <audio>-Element prüfen (z.B. Apple Lossless)
function probeWithElement(ab, mime) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([ab], { type: mime }));
    const a = new Audio();
    a.preload = 'metadata';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error('Zeitüberschreitung')), 8000);
    a.onloadedmetadata = () => finish(resolve, isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => finish(reject, new Error('Format nicht abspielbar'));
    a.src = url;
  });
}

async function applyDraftAudio(ab, mime, source, fileName) {
  let buf = null;
  let duration = 0;
  try {
    buf = await decode(ab);
    duration = buf.duration;
  } catch (err) {
    try {
      duration = await probeWithElement(ab, mime);
    } catch (err2) {
      dialog({
        title: 'Datei kann nicht verwendet werden',
        text: (fileName ? '„' + fileName + '“' : 'Die Aufnahme') + ' ließ sich nicht abspielen (' + mime + ', ' +
          Math.round(ab.byteLength / 1024) + ' KB). Möglicherweise ist die Datei beschädigt oder geschützt (z.B. Kauftitel aus iTunes mit Kopierschutz).'
      });
      return false;
    }
  }
  if (!draft) return false;
  draft.audio = ab;
  draft.mime = mime;
  draft.duration = duration;
  draft.source = source;
  draft.audioChanged = true;
  draftBuffer = buf; // null => Wiedergabe über <audio>-Element
  updateEditorUI();
  return true;
}

/* ---------------- Aufnahme ---------------- */

function pickMime() {
  const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

el.edRec.addEventListener('click', () => {
  if (rec) stopRecording(false); else startRecording();
});

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    dialog({ title: 'Aufnahme nicht möglich', text: 'Dieser Browser unterstützt keine Audioaufnahme. Bitte Safari ab iOS 14.3 verwenden und die Seite über https öffnen.' });
    return;
  }
  stopPlayback();
  setSession('play-and-record');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false }
    });
  } catch (err) {
    setSession('playback');
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    dialog({
      title: denied ? 'Kein Mikrofon-Zugriff' : 'Mikrofon-Fehler',
      text: denied
        ? 'Bitte erlaube den Mikrofonzugriff. iPhone: Einstellungen → Apps → Safari → Mikrofon → „Fragen“ oder „Erlauben“. Danach die App neu öffnen.'
        : 'Das Mikrofon konnte nicht gestartet werden (' + ((err && err.message) || err) + ').'
    });
    return;
  }
  if (!draft) { stream.getTracks().forEach((t) => t.stop()); setSession('playback'); return; }

  const mime = pickMime();
  let mr;
  try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { mr = new MediaRecorder(stream); }

  const r = { mr, stream, chunks: [], startedAt: Date.now(), discard: false, timer: 0 };
  rec = r;
  mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
  mr.onstop = async () => {
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    if (rec === r) rec = null;
    setSession('playback');
    resetCtx();
    if (r.discard) { updateEditorUI(); return; }
    const type = mr.mimeType || mime || 'audio/mp4';
    const blob = new Blob(r.chunks, { type });
    if (!blob.size || Date.now() - r.startedAt < 250) {
      toast('Aufnahme zu kurz');
      updateEditorUI();
      return;
    }
    const ab = await blob.arrayBuffer();
    const ok = await applyDraftAudio(ab, type.split(';')[0], 'Aufnahme');
    if (!ok) updateEditorUI();
  };
  mr.start();
  const upd = () => {
    const ms = Date.now() - r.startedAt;
    el.edRec.textContent = '■ Stopp · ' + fmtClock(ms);
    if (ms >= MAX_REC_MS) stopRecording(false);
  };
  upd();
  r.timer = setInterval(upd, 250);
  updateEditorUI();
}

function stopRecording(discard) {
  if (!rec) return;
  rec.discard = !!discard;
  clearInterval(rec.timer);
  if (rec.mr.state !== 'inactive') rec.mr.stop();
}

/* ---------------- Menü, Backup, Hilfe ---------------- */

el.menuBtn.addEventListener('click', () => openOverlay(el.menu));
el.menu.addEventListener('click', (e) => {
  if (e.target === el.menu) { closeOverlay(el.menu); return; }
  const b = e.target.closest('.menu-item');
  if (!b) return;
  closeOverlay(el.menu);
  const a = b.dataset.action;
  if (a === 'export') exportBackup();
  else if (a === 'import') el.backupFile.click();
  else if (a === 'help') showHelp();
});

function exportBackup() {
  if (!tiles.length) { toast('Noch keine Tasten zum Sichern'); return; }
  // bewusst synchron bis navigator.share (iOS verlangt eine aktive Nutzergeste)
  const data = {
    app: 'soundboard',
    version: 1,
    exportedAt: new Date().toISOString(),
    tiles: tiles.map((t) => ({
      name: t.name, emoji: t.emoji, color: t.color,
      mime: t.mime, duration: t.duration, source: t.source,
      audio: t.audio ? abToB64(t.audio) : null
    }))
  };
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const fname = 'soundboard-backup-' + stamp + '.json';
  const file = new File([JSON.stringify(data)], fname, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Soundboard-Backup' }).catch((err) => {
      if (err && err.name !== 'AbortError') downloadFile(file);
    });
    return;
  }
  downloadFile(file);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  toast('Backup wird heruntergeladen');
}

el.backupFile.addEventListener('change', async () => {
  const f = el.backupFile.files && el.backupFile.files[0];
  el.backupFile.value = '';
  if (!f) return;
  let data;
  try {
    data = JSON.parse(await f.text());
    if (!data || data.app !== 'soundboard' || !Array.isArray(data.tiles)) throw new Error('format');
  } catch (err) {
    dialog({ title: 'Ungültige Datei', text: 'Das ist kein Soundboard-Backup.' });
    return;
  }
  const n = data.tiles.length;
  const buttons = [{ label: 'Hinzufügen', value: 'add', style: '' }];
  if (tiles.length) buttons.push({ label: 'Alle vorhandenen ersetzen', value: 'replace', style: 'danger' });
  buttons.push({ label: 'Abbrechen', value: null, style: 'cancel' });
  const choice = await dialog({
    title: 'Backup importieren',
    text: n + (n === 1 ? ' Taste' : ' Tasten') + ' gefunden.' + (tiles.length ? ' Zu deinen ' + tiles.length + ' Tasten hinzufügen oder alles ersetzen?' : ''),
    buttons
  });
  if (!choice) return;

  stopPlayback();
  let base = tiles.length;
  if (choice === 'replace') {
    try { await dbClear(); } catch (err) { toast('Import fehlgeschlagen'); return; }
    tiles = [];
    buffers.clear();
    base = 0;
  }
  const imported = [];
  data.tiles.forEach((x, i) => {
    let audio = null;
    try { audio = x.audio ? b64ToAb(x.audio) : null; } catch (err) { audio = null; }
    imported.push({
      id: uid(),
      name: String(x.name || '').slice(0, 30),
      emoji: firstGrapheme(x.emoji || ''),
      color: /^#[0-9a-f]{6}$/i.test(x.color || '') ? x.color : COLORS[(base + i) % COLORS.length],
      order: base + i,
      audio,
      mime: x.mime || '',
      duration: Number(x.duration) || 0,
      source: x.source || 'Aufnahme'
    });
  });
  try { await dbPutMany(imported); } catch (err) {
    dialog({ title: 'Import fehlgeschlagen', text: 'Möglicherweise ist der Speicher voll.' });
    return;
  }
  tiles = tiles.concat(imported);
  requestPersist();
  render();
  imported.forEach((t) => decodeTile(t));
  toast(imported.length + (imported.length === 1 ? ' Taste importiert' : ' Tasten importiert'));
});

function showHelp() {
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  dialog({
    title: 'So funktioniert’s',
    html:
      '<p><b>Abspielen:</b> Tippe auf eine Taste. Nochmal tippen oder ■ unten stoppt den Sound.</p>' +
      '<p><b>Bearbeiten:</b> Tippe oben rechts auf „Bearbeiten“. Tippe dann auf eine Taste, um Name, Symbol, Farbe oder Sound zu ändern. Mit dem ⠿-Griff verschiebst du Tasten.</p>' +
      (standalone ? '' : '<p><b>Als App installieren:</b> In Safari auf <i>Teilen</i> → „Zum Home-Bildschirm“.</p>') +
      '<p><b>Speicher:</b> Deine Sounds liegen nur auf diesem Gerät. Die Home-Bildschirm-App und Safari haben <i>getrennte</i> Speicher. Sichere regelmäßig über ⋯ → „Backup exportieren“.</p>' +
      '<p><b>Kein Ton?</b> Lautstärke prüfen. Bei älteren iOS-Versionen spielt die App bei aktivem Lautlos-Schalter nichts ab.</p>' +
      '<p style="color:#8a93a6;font-size:13px">Version ' + APP_VERSION + '</p>',
    buttons: [{ label: 'Alles klar', value: true }]
  });
}

/* ---------------- Lebenszyklus ---------------- */

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPlayback();
    if (rec) stopRecording(false);
  }
});

async function init() {
  setSession('playback');
  buildEditorStatic();
  try {
    tiles = (await dbGetAll()).sort((a, b) => a.order - b.order);
  } catch (err) {
    tiles = [];
    toast('Speicher nicht verfügbar (privater Modus?)');
  }
  render();
  tiles.forEach((t) => decodeTile(t));

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
