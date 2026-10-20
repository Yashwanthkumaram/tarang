import { api } from '../api.js';
import { pickFolder } from '../components/pickers.js';
import { esc, fmtAgo, fmtNum, guard, icon, modal, on, toast } from '../ui.js';

const MODES = [
  ['whole_device', 'Whole device', 'Scan every readable folder for audio. Slowest, finds everything. Uses the exclude list.'],
  ['selected_folders', 'Only selected folders', 'Scan just the folders in the include list plus the app folder. Recommended on Android.'],
  ['app_folder_only', 'App folder only', 'Read only the folder dedicated to this app. Anything you drop there is picked up.'],
];
const ALL_EXT = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'aiff', 'mka', 'wma', 'amr', '3ga'];

export const folders = {
  title: 'Scan & folders',
  async render(root) {
    const platform = await api.platform();
    async function load() {
      const [cfg, last] = await Promise.all([api.scanConfig(), api.lastScan()]);
      const rules = cfg.rules;
      const app = rules.find((r) => r.rule === 'app');
      const includes = rules.filter((r) => r.rule === 'include'), excludes = rules.filter((r) => r.rule === 'exclude');
      const folderRow = (r, cls) => `<div class="folder ${cls} ${r.enabled ? '' : 'disabled'}" data-id="${r.id}"><span class="ic">${icon('folder')}</span><div class="flex-1"><div class="bold ellipsis">${esc(r.path.split('/').filter(Boolean).pop() || r.path)}${cls === 'is-app' ? ' <span class="badge voice">App folder</span>' : ''}${r.path.startsWith('/') ? '' : ' <span class="badge">pattern</span>'}</div><div class="path ellipsis">${esc(r.path.startsWith('/') ? r.path : 'any folder named this, at any depth')}</div></div><div class="row gap-1">${cls === 'is-app' ? `<button class="btn btn-sm" data-change-app>Change</button>` : `<span class="toggle ${r.enabled ? 'on' : ''}" data-toggle-rule title="Enabled"></span><button class="btn btn-icon btn-ghost" data-remove title="Remove">${icon('x')}</button>`}</div></div>`;
      root.innerHTML = `
        <div class="view-head">
          <div><h1>Scan &amp; folders</h1><p class="sub">Decide where the app looks for audio on this device, and which folders to skip.</p></div>
          <div class="row gap-2"><button class="btn btn-primary" id="scan">${icon('refresh')}Scan now</button></div>
        </div>

        <div class="section-head" style="margin-top:0"><h2>This device</h2></div>
        <div class="device active"><span class="ic">${icon(platform.is_mobile ? 'phone' : 'laptop')}</span><div class="flex-1"><div class="bold">${esc(platform.os === 'linux' ? 'This PC (Linux)' : platform.os === 'android' ? 'This phone (Android)' : platform.os)}</div><div class="small muted">${last ? `${fmtNum(last[1].music)} songs · ${fmtNum(last[1].voice)} recordings · last scan ${fmtAgo(last[0])}` : 'Never scanned'}</div></div><span class="dot on"></span></div>

        <div class="section">
          <div class="section-head"><h2>Where to look</h2></div>
          <div class="radio-cards" id="modes">${MODES.map(([v, t, d]) => `<button class="radio-card ${cfg.mode === v ? 'active' : ''}" data-mode="${v}"><div class="t">${t}</div><div class="d">${d}</div></button>`).join('')}</div>
        </div>

        <div class="section grid grid-2">
          <div class="card">
            <div class="row between"><h3><span class="badge voice" style="margin-right:6px">Include</span>Scan these folders</h3><button class="btn btn-sm" data-add="include">${icon('plus')}Add folder</button></div>
            <div class="grid mt-3" style="gap:8px" id="includes">
              ${app ? folderRow(app, 'is-app') : `<button class="folder is-app" data-change-app style="cursor:pointer"><span class="ic">${icon('plus')}</span><div class="flex-1"><div class="bold">Choose an app folder</div><div class="path">Downloads and torrents are saved here. Currently: ${esc(platform.download_dir)}</div></div><span></span></button>`}
              ${includes.map((r) => folderRow(r, 'include')).join('') || '<p class="small muted">No include folders. Add one, or switch to "Whole device".</p>'}
            </div>
          </div>
          <div class="card">
            <div class="row between"><h3><span class="badge danger" style="margin-right:6px">Exclude</span>Never scan these</h3><div class="row gap-1"><button class="btn btn-sm" data-add="exclude">${icon('plus')}Folder</button><button class="btn btn-sm" data-add-pattern>${icon('plus')}Name pattern</button></div></div>
            <div class="grid mt-3" style="gap:8px" id="excludes">${excludes.map((r) => folderRow(r, 'exclude')).join('') || '<p class="small muted">Nothing excluded.</p>'}</div>
            <div class="setting mt-4" style="border-top:1px solid var(--border);padding-top:14px"><div><div class="label">Respect .nomedia files</div><div class="desc">Android convention: skip folders that contain a .nomedia marker.</div></div><span class="toggle ${cfg.respect_nomedia ? 'on' : ''}" data-setting="scan.respect_nomedia"></span></div>
            <div class="setting"><div><div class="label">Skip files shorter than</div><div class="desc">Notification sounds are 1–2 s. Keep this low so short voice memos survive.</div></div><select class="select" data-setting-select="scan.min_duration_secs">${[0, 2, 5, 10, 30].map((s) => `<option value="${s}" ${cfg.min_duration_secs == s ? 'selected' : ''}>${s ? s + ' s' : 'Never'}</option>`).join('')}</select></div>
          </div>
        </div>

        <div class="section grid grid-2">
          <div class="card">
            <h3>File types</h3>
            <div class="chip-row mt-3" id="exts">${ALL_EXT.map((e) => `<button class="chip ${cfg.extensions.includes(e) ? 'active' : ''}" data-ext="${e}">${e.toUpperCase()}</button>`).join('')}</div>
            <p class="small muted mt-3">AMR and 3GA are almost always phone recordings. Turn them on if you want calls and memos in the Voice section.</p>
          </div>
          <div class="card">
            <h3>Music vs voice classifier</h3>
            <div class="setting mt-2"><div><div class="label">Classify new files during scan</div><div class="desc">Decodes ~40 s of each new file on device. Off = everything is music.</div></div><span class="toggle ${cfg.classify ? 'on' : ''}" data-setting="classifier.enabled"></span></div>
            <div class="setting"><div><div class="label">Confidence needed to auto-file</div><div class="desc">Below this the file goes to the review queue instead.</div></div><select class="select" data-setting-select="classifier.threshold">${[[0.3, 'Low (30%)'], [0.5, 'Medium (50%)'], [0.75, 'High (75%)']].map(([v, l]) => `<option value="${v}" ${Math.abs(cfg.confidence_threshold - v) < 0.01 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <div class="setting"><div><div class="label">Use folder and file names as hints</div><div class="desc">"Recordings", "Call rec", PTT-…, timestamps, missing artist tag.</div></div><span class="toggle ${cfg.use_hints ? 'on' : ''}" data-setting="classifier.use_hints"></span></div>
          </div>
        </div>

        ${last ? `<div class="section card">
          <div class="row between wrap"><h3>Last scan</h3><span class="small muted">${fmtAgo(last[0])} · ${(last[1].elapsed_ms / 1000).toFixed(1)} s</span></div>
          <div class="grid grid-4 mt-3">
            <div class="stat"><span class="value">${fmtNum(last[1].audio_found)}</span><span class="label">Audio files found</span></div>
            <div class="stat"><span class="value">${fmtNum(last[1].music)}</span><span class="label">Filed as music</span></div>
            <div class="stat"><span class="value">${fmtNum(last[1].voice)}</span><span class="label">Filed as voice</span></div>
            <div class="stat"><span class="value">${fmtNum(last[1].skipped + last[1].removed)}</span><span class="label">Skipped / removed</span></div>
          </div>
        </div>` : ''}`;
    }

    root.addEventListener('click', (e) => { if (e.target.closest('#scan')) guard(() => api.startScan(), 'Scan started'); });
    on(root, 'click', '#modes .radio-card', async (e, b) => { await api.setSetting('scan.mode', b.dataset.mode); load(); });
    on(root, 'click', '[data-add]', async (e, b) => {
      const p = await pickFolder(platform);
      if (p) { await guard(() => api.addRule(p, b.dataset.add)); load(); }
    });
    on(root, 'click', '[data-change-app]', async () => {
      const p = await pickFolder(platform);
      if (p) { await guard(() => api.addRule(p, 'app'), 'App folder set'); load(); }
    });
    on(root, 'click', '[data-add-pattern]', () => {
      modal({ title: 'Exclude by folder name', body: `<p class="muted small">Any folder with this exact name is skipped wherever it is. Examples: <b>node_modules</b>, <b>.cache</b>, <b>Ringtones</b>.</p><input class="input mt-3" id="pat" placeholder="Folder name">`, footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pat-ok">Add</button>`,
        onMount(el, close) { el.querySelector('#pat-ok').addEventListener('click', async () => { const v = el.querySelector('#pat').value.trim().replace(/\//g, ''); if (!v) return; await guard(() => api.addRule(v, 'exclude')); close(); load(); }); } });
    });
    on(root, 'click', '[data-remove]', async (e, b) => { await guard(() => api.removeRule(Number(b.closest('.folder').dataset.id))); load(); });
    on(root, 'click', '[data-toggle-rule]', async (e, t) => { const row = t.closest('.folder'); t.classList.toggle('on'); row.classList.toggle('disabled', !t.classList.contains('on')); await api.setRuleEnabled(Number(row.dataset.id), t.classList.contains('on')); });
    on(root, 'click', '[data-setting]', async (e, t) => { t.classList.toggle('on'); await api.setSetting(t.dataset.setting, t.classList.contains('on')); });
    on(root, 'change', '[data-setting-select]', async (e, s) => { await api.setSetting(s.dataset.settingSelect, s.value); });
    on(root, 'click', '#exts .chip', async (e, c) => {
      c.classList.toggle('active');
      const list = Array.from(root.querySelectorAll('#exts .chip.active')).map((x) => x.dataset.ext);
      if (!list.length) { c.classList.add('active'); toast('Keep at least one type', { error: true }); return; }
      await api.setSetting('scan.extensions', list.join(','));
    });
    const onScan = (ev) => { if (ev.detail?.finished) load(); };
    window.addEventListener('scan:progress', onScan);
    await load();
    return () => window.removeEventListener('scan:progress', onScan);
  },
};
