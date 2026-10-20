import { api, pickFile } from '../api.js';
import { go } from '../router.js';
import { emptyState, esc, guard, icon, modal, on, pct, toast } from '../ui.js';

export const imports = {
  title: 'Import accounts',
  async render(root) {
    async function load() {
      const lists = await api.imports();
      const by = (s) => lists.filter((p) => p.source === s);
      const sum = (arr, k) => arr.reduce((a, p) => a + p[k], 0);
      const card = (source, label, logo, help) => {
        const mine = by(source);
        const total = sum(mine, 'total'), matched = sum(mine, 'matched');
        return `<div class="card">
          <div class="row between">
            <div class="row gap-2"><span class="badge ${source}" style="width:32px;height:32px;justify-content:center;font-size:15px;border-radius:8px">${logo}</span><div><h3>${label}</h3><span class="small muted">${mine.length ? `${mine.length} playlists imported` : 'Nothing imported yet'}</span></div></div>
            <span class="badge">Export file</span>
          </div>
          ${mine.length ? `<dl class="kv mt-4"><dt>Entries</dt><dd>${total}</dd><dt>Matched to files you own</dt><dd>${matched} (${pct(total ? matched / total : 0)})</dd><dt>Unmatched</dt><dd>${total - matched}</dd></dl><div class="progress mt-3"><span style="width:${pct(total ? matched / total : 0)}"></span></div>` : `<p class="muted mt-4">${help}</p>`}
          <div class="row gap-2 mt-4 wrap"><button class="btn btn-sm btn-primary" data-import-file="${source}">${icon('import')}Import export file</button><button class="btn btn-sm" data-import-text="${source}">${icon('list')}Paste a list</button></div>
        </div>`;
      };
      root.innerHTML = `
        <div class="view-head">
          <div><h1>Import accounts</h1><p class="sub">Pull playlists and liked songs from the services you use, then match each entry to a file on this device.</p></div>
          <button class="btn" id="rematch">${icon('refresh')}Re-match everything</button>
        </div>
        <div class="grid grid-2">
          ${card('spotify', 'Spotify', 'S', 'Spotify → Privacy settings → Download your data gives you <b>YourLibrary.json</b> and <b>Playlist1.json</b>. Exportify CSV files work too.')}
          ${card('youtube', 'YouTube / YouTube Music', '▶', 'Google Takeout → YouTube and YouTube Music → playlists and <b>music-library-songs.csv</b>.')}
        </div>
        <div class="section">
          <div class="section-head"><h2>Imported playlists</h2></div>
          <div class="card flush" id="lists">${lists.length ? lists.map((p) => `
            <div class="result" style="grid-template-columns:44px minmax(0,1fr) auto" data-id="${p.id}">
              <div class="art"><span class="badge ${esc(p.source)}">${p.source === 'spotify' ? 'S' : '▶'}</span></div>
              <div style="min-width:0"><div class="bold ellipsis">${esc(p.name)}</div>
                <div class="row gap-2 mt-2"><div class="progress flex-1 ${p.source === 'youtube' ? 'server' : 'ok'}"><span style="width:${pct(p.total ? p.matched / p.total : 0)}"></span></div><span class="small muted nw">${p.matched}/${p.total} matched</span></div></div>
              <div class="acts"><button class="btn btn-sm" data-view>${icon('list')}Entries</button>${p.matched < p.total ? `<button class="btn btn-sm btn-primary" data-find>${icon('server')}Find on server</button>` : ''}<button class="btn btn-icon btn-ghost" data-del title="Remove">${icon('x')}</button></div>
            </div>`).join('') : emptyState('import', 'No imports yet', 'Import an export file from Spotify or YouTube above.')}</div>
        </div>
        <div class="section card">
          <h3>How matching works</h3>
          <div class="grid grid-3 mt-3">
            <div><span class="badge local">1</span><p class="mt-2"><b>Title + artist + length.</b> Each entry is compared with your scanned library. Exact title, artist contained, duration within 4 s.</p></div>
            <div><span class="badge server">2</span><p class="mt-2"><b>Server fills gaps.</b> "Find on server" searches the first unmatched entry on My server so you can stream or download it.</p></div>
            <div><span class="badge torrent">3</span><p class="mt-2"><b>Re-match later.</b> After scans and downloads the app re-matches automatically; the button above forces it.</p></div>
          </div>
        </div>`;
    }

    on(root, 'click', '[data-import-file]', async (e, b) => {
      const path = await pickFile(['json', 'csv', 'txt']);
      if (!path) return;
      const res = await guard(() => api.importFile(path, b.dataset.importFile));
      if (res) { toast(`Imported ${res.length} playlist${res.length === 1 ? '' : 's'}`); load(); }
    });
    on(root, 'click', '[data-import-text]', (e, b) => {
      const source = b.dataset.importText;
      modal({
        title: 'Paste a list',
        body: `<label class="field"><span>Playlist name</span><input class="input" id="im-name" value="Pasted list"></label><label class="field mt-3"><span>One song per line, as <b>Artist - Title</b> or just <b>Title</b></span><textarea class="textarea" id="im-text" placeholder="Daft Punk - Get Lucky&#10;Kavinsky - Nightcall"></textarea></label>`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="im-ok">${icon('import')}Import</button>`,
        onMount(el, close) {
          el.querySelector('#im-ok').addEventListener('click', async () => {
            const text = el.querySelector('#im-text').value;
            if (!text.trim()) return;
            const r = await guard(() => api.importText(text, el.querySelector('#im-name').value || 'Pasted list', source));
            if (r) { close(); toast(`Matched ${r.matched} of ${r.total}`); load(); }
          });
        },
      });
    });
    on(root, 'click', '[data-del]', async (e, b) => { await guard(() => api.deleteImport(Number(b.closest('.result').dataset.id))); load(); });
    on(root, 'click', '[data-view]', async (e, b) => {
      const id = Number(b.closest('.result').dataset.id);
      const items = await api.importItems(id, false);
      modal({ title: 'Entries', body: `<div class="track-list">${items.map((i) => `<div class="result" style="grid-template-columns:minmax(0,1fr) auto;padding:8px 0"><div style="min-width:0"><div class="ellipsis">${esc(i.title)}</div><div class="small muted ellipsis">${esc(i.artist || '')}${i.album ? ' · ' + esc(i.album) : ''}</div></div>${i.matched_track_id ? `<span class="badge ok">${icon('check')}Matched</span>` : `<button class="btn btn-sm" data-q="${esc(`${i.artist || ''} ${i.title}`.trim())}">${icon('server')}Search</button>`}</div>`).join('') || '<p class="muted">Empty</p>'}</div>`,
        onMount(el, close) { el.addEventListener('click', (e) => { const q = e.target.closest('[data-q]'); if (q) { sessionStorage.setItem('search.query', q.dataset.q); close(); go('search'); } }); } });
    });
    on(root, 'click', '[data-find]', async (e, b) => {
      const id = Number(b.closest('.result').dataset.id);
      const items = await api.importItems(id, true);
      if (!items.length) return;
      sessionStorage.setItem('search.query', `${items[0].artist || ''} ${items[0].title}`.trim());
      go('search');
    });
    root.addEventListener('click', async (e) => { if (e.target.closest('#rematch')) { const n = await guard(() => api.rematch()); toast(`${n ?? 0} newly matched`); load(); } });
    await load();
  },
};
