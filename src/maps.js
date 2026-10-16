let promise;

export function loadGoogleMaps() {
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!key) return reject(new Error('Google Maps APIキーが設定されていません'));
    window.__gmapsInit = () => resolve(window.google.maps);
    window.gm_authFailure = () => reject(new Error('Google Maps APIの認証に失敗しました（キー/リファラー制限を確認）'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__gmapsInit&loading=async&language=ja`;
    s.async = true;
    s.onerror = () => reject(new Error('Google Maps APIの読み込みに失敗しました'));
    document.head.appendChild(s);
  });
  return promise;
}
