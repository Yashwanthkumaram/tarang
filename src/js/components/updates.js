// App updates from GitHub Releases (D45). Shared by Settings › About and the start-up check.
// The backend does the platform work (desktop: signed Tauri updater; Android: download the
// APK and open the system installer); this module keeps the state and tells listeners.
import { api, isTauri, listen } from '../api.js';
import { online } from './store.js';
import { toast } from '../ui.js';

const LAST_CHECK = 'update.lastCheck';
const DAY_MS = 24 * 3600 * 1000;

/** { phase: idle|checking|uptodate|available|downloading|permission|error, info?, downloaded?, total?, error? } */
let state = { phase: 'idle' };
const subs = new Set();
function set(next) { state = { ...state, ...next }; subs.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }

export const updates = {
  get state() { return state; },
  subscribe(fn) { subs.add(fn); fn(state); return () => subs.delete(fn); },

  async check() {
    if (state.phase === 'downloading') return state.info;
    set({ phase: 'checking', error: null });
    try {
      const info = await api.updateCheck();
      try { localStorage.setItem(LAST_CHECK, String(Date.now())); } catch {}
      set({ phase: info.available ? 'available' : 'uptodate', info });
      return info;
    } catch (err) {
      set({ phase: 'error', error: err.message || String(err) });
      throw err;
    }
  },

  async install() {
    if (state.phase === 'downloading') return;
    set({ phase: 'downloading', downloaded: 0, total: state.info?.asset_size || 0, error: null });
    const unlisten = await listen('update://progress', (e) => set({ downloaded: e.payload.downloaded, total: e.payload.total || state.total }));
    try {
      const status = await api.updateInstall();
      // Desktop restarts into the new version before this returns. On Android the system
      // installer is now on screen; "needs_permission" means Android first wants the user
      // to allow installs from Tarang, then tap Update again.
      set({ phase: status === 'needs_permission' ? 'permission' : 'available' });
      return status;
    } catch (err) {
      set({ phase: 'error', error: err.message || String(err) });
      throw err;
    } finally {
      unlisten?.();
    }
  },
};

/** At start-up: a quiet check at most once a day; a toast only when there is something new. */
export function autoCheckUpdates() {
  if (!isTauri) return;
  let last = 0;
  try { last = +localStorage.getItem(LAST_CHECK) || 0; } catch {}
  if (Date.now() - last < DAY_MS) return;
  setTimeout(async () => {
    if (!online.value) return;
    try {
      const info = await updates.check();
      if (info.available) {
        toast(`Tarang ${info.version} is available`, {
          kind: 'info', sub: `You have ${info.current}`, ms: 12000,
          action: { label: 'Update', run: () => { location.hash = '#settings?section=about'; } },
        });
      }
    } catch { /* offline or GitHub unreachable: try again next start */ }
  }, 8000);
}
