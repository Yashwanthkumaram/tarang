// Folder picker for Device folders / download location. Desktop uses the native dialog;
// Android (whose native picker returns content URIs) and the browser preview use an
// in-app browser over the `list_dirs` command.
//
//   const path = await pickFolder({ title: 'Add a music folder', start: '/storage/emulated/0' });

import { api, pickFolderNative } from '../api.js';
import { esc, icon, isPhone } from '../ui.js';
import { openModal, openSheet } from './overlay.js';

export async function pickFolder({ title = 'Choose a folder', start = null, confirm = 'Use this folder' } = {}) {
  const native = await pickFolderNative().catch(() => null);
  if (native) return native;
  let root = start;
  if (!root) {
    const p = await api.platform().catch(() => ({}));
    root = p.os === 'android' || p.is_mobile ? '/storage/emulated/0' : '/home';
  }
  return new Promise((resolve) => {
    let current = root, chosen = null;
    const body = document.createElement('div');
    body.className = 'folder-picker stack';
    body.innerHTML = `<div class="folder-picker__path t-13 muted truncate num"></div><div class="list folder-picker__list"></div>`;
    const pathEl = body.querySelector('.folder-picker__path');
    const listEl = body.querySelector('.folder-picker__list');
    async function show(path) {
      current = path;
      pathEl.textContent = path;
      listEl.innerHTML = `<div class="skel-row"><i class="skel skel--art"></i><i class="skel skel--text w-80"></i><i></i></div>`;
      const dirs = await api.listDirs(path).catch(() => []);
      const up = path.replace(/\/[^/]+\/?$/, '') || '/';
      listEl.innerHTML = `${path !== '/' ? `<button class="menu__item" type="button" data-dir="${esc(up)}">${icon('chevron-left')}<span class="grow">Up one level</span></button>` : ''}${dirs.length
        ? dirs.map((d) => `<button class="menu__item" type="button" data-dir="${esc(d)}">${icon('folder')}<span class="grow truncate">${esc(d.split('/').pop())}</span>${icon('chevron-right', 'icon--16')}</button>`).join('')
        : '<div class="t-13 muted folder-picker__empty">No sub-folders here.</div>'}`;
    }
    listEl.addEventListener('click', (e) => { const b = e.target.closest('[data-dir]'); if (b) show(b.dataset.dir); });
    const actions = `<div class="modal__actions"><button class="btn btn--ghost" type="button" data-cancel>Cancel</button><button class="btn btn--primary" type="button" data-ok>${esc(confirm)}</button></div>`;
    body.insertAdjacentHTML('beforeend', actions);
    const o = isPhone() ? openSheet({ title, body, onClose: () => resolve(chosen) }) : openModal({ title, body, onClose: () => resolve(chosen) });
    body.querySelector('[data-cancel]').addEventListener('click', () => o.close());
    body.querySelector('[data-ok]').addEventListener('click', () => { chosen = current; o.close(); });
    show(root);
  });
}
