import {
  doc, getDoc, collection, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { db, ensureSignedIn } from './firebase.js';
import { loadGoogleMaps } from './maps.js';

const app = document.getElementById('app');
const DEFAULT_CENTER = { lat: 39.7, lng: 140.1 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const fmt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString('ja-JP') : '保存中…');

function showError(title, message) {
  app.innerHTML = `<div class="fullscreen-msg"><h1>${esc(title)}</h1><p>${esc(message)}</p></div>`;
}

function getRegionId() {
  const base = import.meta.env.BASE_URL;
  let path = location.pathname;
  if (path.startsWith(base)) path = path.slice(base.length);
  const id = path.split('/').filter(Boolean)[0];
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

let toastTimer;
function toast(message, isError = true) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${isError ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 5000);
}

function askMemo({ title, name = '', text = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <form class="dialog">
        <h2>${esc(title)}</h2>
        <label>ユーザー名<input name="userName" maxlength="50" required value="${esc(name)}" /></label>
        <label>メモ<textarea name="text" rows="5" maxlength="2000" required>${esc(text)}</textarea></label>
        <div class="row">
          <button type="button" class="secondary" data-cancel>キャンセル</button>
          <button type="submit">保存</button>
        </div>
      </form>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('form');
    const close = (v) => { overlay.remove(); resolve(v); };
    form.userName.focus();
    overlay.querySelector('[data-cancel]').onclick = () => close(null);
    form.onsubmit = (e) => {
      e.preventDefault();
      const userName = form.userName.value.trim();
      const body = form.text.value.trim();
      if (!userName || !body) return;
      localStorage.setItem('geomemo:userName', userName);
      close({ userName, text: body });
    };
  });
}

async function main() {
  const regionId = getRegionId();
  if (!regionId) {
    return showError('地域が指定されていません', 'URLに地域名を含めてください（例: /geomemo/akita/）');
  }

  app.innerHTML = '<div class="fullscreen-msg"><p>読み込み中…</p></div>';

  let region;
  try {
    await ensureSignedIn();
    const snap = await getDoc(doc(db, 'regions', regionId));
    if (!snap.exists()) {
      return showError('地域が見つかりません', `「${regionId}」は存在しません。URLを確認してください。`);
    }
    region = snap.data();
  } catch (e) {
    console.error(e);
    return showError('接続エラー', `サーバーに接続できませんでした。ネットワークを確認して再読み込みしてください。(${e.code || e.message})`);
  }

  let maps;
  try {
    maps = await loadGoogleMaps();
  } catch (e) {
    return showError('地図エラー', e.message);
  }

  document.title = `${region.name || regionId} | GeoMemo`;
  app.innerHTML = `
    <div id="map"></div>
    <button id="locate" class="fab" title="現在地へ移動" aria-label="現在地へ移動">
      <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 3A8.994 8.994 0 0013 3.06V1h-2v2.06A8.994 8.994 0 003.06 11H1v2h2.06A8.994 8.994 0 0011 20.94V23h2v-2.06A8.994 8.994 0 0020.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>
    </button>
    <div id="offline" class="offline" hidden>オフラインです。変更は接続回復後に反映されます。</div>
    <div id="toast" class="toast"></div>`;

  const c = region.center || {};
  const lat = c.latitude ?? c.lat ?? region.lat ?? DEFAULT_CENTER.lat;
  const lng = c.longitude ?? c.lng ?? region.lng ?? DEFAULT_CENTER.lng;
  const map = new maps.Map(document.getElementById('map'), {
    center: { lat, lng },
    zoom: Number(region.zoom) || 13,
    gestureHandling: 'greedy',
    fullscreenControl: false,
    streetViewControl: false,
    mapTypeControl: true,
    mapTypeControlOptions: { position: maps.ControlPosition.LEFT_TOP },
  });

  // TOP_LEFT の地域名の下に LEFT_TOP の地図種別ボタンが並ぶ（Maps が重なりを回避）
  const titlebar = document.createElement('div');
  titlebar.className = 'titlebar';
  titlebar.textContent = region.name || regionId;
  map.controls[maps.ControlPosition.TOP_LEFT].push(titlebar);

  const info = new maps.InfoWindow();
  const markers = new Map();
  const memos = new Map();
  const memosCol = collection(db, 'regions', regionId, 'memos');

  const syncOffline = () => { document.getElementById('offline').hidden = navigator.onLine; };
  window.addEventListener('online', syncOffline);
  window.addEventListener('offline', syncOffline);
  syncOffline();

  const run = async (label, fn) => {
    try { await fn(); } catch (e) {
      console.error(e);
      const msg = e.code === 'permission-denied' ? '権限がありません'
        : !navigator.onLine || e.code === 'unavailable' ? 'ネットワークに接続できません' : (e.code || e.message);
      toast(`${label}に失敗しました: ${msg}`);
    }
  };

  function openInfo(id) {
    const m = memos.get(id);
    const marker = markers.get(id);
    if (!m || !marker) return;
    const div = document.createElement('div');
    div.className = 'info';
    div.innerHTML = `
      <div class="info-user">${esc(m.userName)}</div>
      <div class="info-text">${esc(m.text)}</div>
      <div class="info-meta">緯度 ${m.lat.toFixed(6)} / 経度 ${m.lng.toFixed(6)}<br>作成: ${fmt(m.createdAt)}<br>更新: ${fmt(m.updatedAt)}</div>
      <div class="row"><button data-edit>編集</button><button data-del class="danger">削除</button></div>`;
    div.querySelector('[data-edit]').onclick = async () => {
      info.close();
      const v = await askMemo({ title: 'メモを編集', name: m.userName, text: m.text });
      if (!v) return;
      run('更新', () => updateDoc(doc(memosCol, id), { ...v, updatedAt: serverTimestamp() }));
    };
    div.querySelector('[data-del]').onclick = () => {
      if (!confirm('このメモを削除しますか？')) return;
      info.close();
      run('削除', () => deleteDoc(doc(memosCol, id)));
    };
    info.setContent(div);
    info.open({ map, anchor: marker });
  }

  onSnapshot(memosCol, (snap) => {
    snap.docChanges().forEach((ch) => {
      const id = ch.doc.id;
      if (ch.type === 'removed') {
        markers.get(id)?.setMap(null);
        markers.delete(id);
        memos.delete(id);
        return;
      }
      const d = ch.doc.data();
      memos.set(id, d);
      let mk = markers.get(id);
      if (!mk) {
        mk = new maps.Marker({ map });
        mk.addListener('click', () => openInfo(id));
        markers.set(id, mk);
      }
      mk.setPosition({ lat: d.lat, lng: d.lng });
      mk.setTitle(d.text.slice(0, 30));
    });
  }, (e) => {
    console.error(e);
    toast(`メモの同期に失敗しました: ${e.code || e.message}`);
  });

  map.addListener('click', async (ev) => {
    info.close();
    const pos = { lat: ev.latLng.lat(), lng: ev.latLng.lng() };
    const v = await askMemo({
      title: 'メモを追加',
      name: localStorage.getItem('geomemo:userName') || '',
    });
    if (!v) return;
    run('保存', () => addDoc(memosCol, {
      ...pos, ...v,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }));
  });

  let here;
  document.getElementById('locate').onclick = () => {
    if (!navigator.geolocation) return toast('この端末は位置情報に対応していません');
    navigator.geolocation.getCurrentPosition((p) => {
      const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      map.panTo(pos);
      if (map.getZoom() < 16) map.setZoom(16);
      if (!here) {
        here = new maps.Marker({
          map, position: pos, zIndex: 1, title: '現在地',
          icon: { path: maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#4285f4', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        });
      } else here.setPosition(pos);
    }, (err) => {
      toast(err.code === 1 ? '位置情報の利用が許可されていません' : '現在地を取得できませんでした');
    }, { enableHighAccuracy: true, timeout: 10000 });
  };
}

main();
