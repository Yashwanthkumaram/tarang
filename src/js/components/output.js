// Audio output picker (Now playing "Output" card on desktop, "Phone speaker" util button on
// phone). Lists audio outputs through navigator.mediaDevices.enumerateDevices() and routes
// through player.setOutput (HTMLMediaElement.setSinkId) when the engine supports it.
// When devices can't be listed or switched (WebKitGTK, Android WebView, native Android
// engine) the picker shows the current sink only — the system routes audio (D43).

import { isAndroid } from '../api.js';
import { player } from '../player.js';

const KEY = 'player.output';
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; };

/** Name of the default sink as the design words it. */
export const defaultOutputLabel = () => (isAndroid ? 'Phone speaker' : 'Built-in speakers');

let cache = null;        // { devices: [{ id, label }], current, canSwitch }
let pending = null;
const subs = new Set();

function cleanLabel(l) {
  // Chromium prefixes the default sink with "Default - " and appends "(vid:pid)".
  return String(l || '').replace(/^Default\s*-\s*/i, '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim();
}

async function list() {
  const md = navigator.mediaDevices;
  let devices = [];
  if (md?.enumerateDevices) {
    try {
      const all = await md.enumerateDevices();
      const seen = new Set();
      for (const d of all) {
        if (d.kind !== 'audiooutput' || d.deviceId === 'communications') continue;
        const label = d.deviceId === 'default' ? defaultOutputLabel() : cleanLabel(d.label);
        if (!label || seen.has(label)) continue;   // unlabeled = no permission to name it
        seen.add(label);
        devices.push({ id: d.deviceId === 'default' ? '' : d.deviceId, label });
      }
    } catch { devices = []; }
  }
  if (!devices.some((d) => d.id === '')) devices.unshift({ id: '', label: defaultOutputLabel() });
  const canSwitch = player.canSetOutput && devices.length > 1;
  const saved = LS(KEY) || '';
  let current = '';
  if (canSwitch && saved && devices.some((d) => d.id === saved)) {
    current = (await player.setOutput(saved)) ? saved : '';
  }
  return { devices, current, canSwitch };
}

/** Resolves the output state, listing devices once (and again after a device change). */
export function outputs() {
  if (cache) return Promise.resolve(cache);
  if (!pending) pending = list().then((r) => { cache = r; pending = null; subs.forEach((fn) => fn(r)); return r; });
  return pending;
}

/** Synchronous snapshot for rendering; null until the first listing resolves. */
export const outputSnapshot = () => cache;

export function currentOutputLabel() {
  const c = cache;
  if (!c) return defaultOutputLabel();
  return c.devices.find((d) => d.id === c.current)?.label || defaultOutputLabel();
}

export async function setOutputDevice(id) {
  const c = await outputs();
  if (!c.canSwitch) return false;
  const ok = await player.setOutput(id);
  if (!ok) return false;
  c.current = id;
  LS(KEY, id);
  subs.forEach((fn) => fn(c));
  return true;
}

export function onOutputs(fn) { subs.add(fn); return () => subs.delete(fn); }

try {
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { cache = null; outputs(); });
} catch {}
