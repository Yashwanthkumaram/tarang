// Player widgets shared by the shell (player bar, mini player) and the Now Playing view:
// scrubber + volume dragging, the sleep-timer picker, and small state formatters.

import { fmtClock, fmtDuration, fmtRemaining, icon } from '../ui.js';
import { openMenu } from './overlay.js';

/**
 * Makes a .scrubber__track / .volume__track draggable. The container (`.scrubber` /
 * `.volume`) gets --p while dragging and .is-active. onChange(fraction, final).
 * Keyboard: ←/→ step, Home/End. Returns unbind.
 */
export function bindSlider(track, { onChange, step = 0.02, container = track.parentElement, getValue } = {}) {
  let dragging = false;
  track.tabIndex = track.tabIndex >= 0 ? track.tabIndex : 0;
  const frac = (e) => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))); };
  const move = (e, final) => { const f = frac(e); container.style.setProperty('--p', `${f * 100}%`); onChange(f, final); };
  const down = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true; container.classList.add('is-active'); container.dataset.dragging = '1';
    track.setPointerCapture?.(e.pointerId); move(e, false); e.preventDefault();
  };
  const mv = (e) => { if (dragging) move(e, false); };
  const up = (e) => { if (!dragging) return; dragging = false; container.classList.remove('is-active'); delete container.dataset.dragging; move(e, true); };
  const key = (e) => {
    const v = getValue ? getValue() : 0;
    let nv = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nv = v + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nv = v - step;
    else if (e.key === 'Home') nv = 0;
    else if (e.key === 'End') nv = 1;
    if (nv == null) return;
    e.preventDefault(); e.stopPropagation();
    onChange(Math.min(1, Math.max(0, nv)), true);
  };
  track.addEventListener('pointerdown', down);
  track.addEventListener('pointermove', mv);
  track.addEventListener('pointerup', up);
  track.addEventListener('pointercancel', up);
  track.addEventListener('keydown', key);
  return () => {
    track.removeEventListener('pointerdown', down); track.removeEventListener('pointermove', mv);
    track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); track.removeEventListener('keydown', key);
  };
}

/** Is the user dragging this scrubber right now (don't overwrite --p). */
export const isDragging = (el) => el?.dataset.dragging === '1';

/**
 * Buffering percentage for the "Buffering… 72%" label: how much of the ~8 s start-up
 * chunk is cached ahead of the playhead (the stream starts once it is full).
 */
export function bufferPct(t) {
  const ahead = Math.max(0, (t.buffered || 0) - (t.position || 0));
  return Math.min(99, Math.round((ahead / 8) * 100));
}

/** True when the UI should show the buffering state for this player snapshot. */
export const showBuffering = (s) => !!s.current && !s.current.path && !!s.current.video_id && !s.error && (s.loading === 'stream' || s.buffering);

/** Updates a .scrubber element from a time tick: --p, --b, aria and times. */
export function paintScrubber(el, t, { buffering = false } = {}) {
  if (!el) return;
  const d = t.duration || 0;
  const p = d ? Math.min(100, (t.position / d) * 100) : 0;
  const b = d ? Math.min(100, (Math.max(t.buffered || 0, t.position) / d) * 100) : 0;
  if (!isDragging(el)) el.style.setProperty('--p', `${p}%`);
  el.style.setProperty('--b', `${b}%`);
  const times = el.querySelectorAll('.scrubber__times span');
  const left = times[0], right = times[times.length - 1];
  if (left) left.textContent = fmtDuration(t.position || 0);
  if (right && right !== left) {
    if (buffering) { right.textContent = `Buffering… ${bufferPct(t)}%`; right.className = 'np-buftext'; right.setAttribute('role', 'status'); }
    else { right.textContent = fmtRemaining(t.position || 0, d); right.className = ''; right.removeAttribute('role'); }
  }
  el.querySelector('.scrubber__thumb')?.classList.toggle('np-thumb--spin', buffering);
  const tr = el.querySelector('.scrubber__track');
  if (tr) {
    tr.setAttribute('aria-valuemin', '0');
    tr.setAttribute('aria-valuemax', String(Math.round(d)));
    tr.setAttribute('aria-valuenow', String(Math.round(t.position || 0)));
    tr.setAttribute('aria-valuetext', `${fmtDuration(t.position)} of ${fmtDuration(d)}${buffering ? ', buffering' : ''}`);
  }
}

/** "Stops in 23:41 · ends 23:05" / "Stops at the end of this song" / '' */
export function sleepLabel(player) {
  const s = player.state.sleep;
  if (!s) return '';
  const rem = player.sleepRemaining();
  if (s.mode === 'end') return `Stops at the end of the song · in ${fmtDuration(rem)}`;
  return `Stops in ${fmtDuration(rem)} · ends ${fmtClock(s.endsAt)}`;
}
/** Compact countdown for pills: "23:41" or "End". */
export function sleepShort(player) {
  const s = player.state.sleep;
  if (!s) return '';
  return s.mode === 'end' ? 'End of song' : fmtDuration(player.sleepRemaining());
}

export const SLEEP_CHOICES = [['Off', null], ['15 min', 15], ['30 min', 30], ['45 min', 45], ['60 min', 60], ['End of song', 'end']];

/** Sleep-timer picker (design: now-playing.html "Sleep timer · picker"). */
export function openSleepMenu(anchor, player) {
  const s = player.state.sleep;
  const nowMs = Date.now();
  const checked = (v) => (v === null ? !s : v === 'end' ? s?.mode === 'end' : s?.mode === 'min' && s.minutes === v);
  const items = [
    { head: `<span class="strong">Sleep timer</span><span class="np-card__value">${sleepLabel(player) || 'Off'}</span>` },
    { sep: true },
    ...SLEEP_CHOICES.map(([label, v]) => ({
      label, checked: checked(v),
      hint: v === null ? '' : v === 'end' ? (player.state.current ? `in ${fmtDuration(Math.max(0, player.state.duration - player.state.position))}` : '') : `ends ${fmtClock(nowMs + v * 60000)}`,
      run: () => player.setSleep(v),
    })),
    s?.mode === 'min' && { sep: true },
    s?.mode === 'min' && { label: 'Add 10 minutes', icon: 'plus', hint: `ends ${fmtClock(s.endsAt + 600000)}`, run: () => player.addSleep(10) },
  ].filter(Boolean);
  return openMenu(anchor, items, { title: 'Sleep timer', className: 'menu--timer', label: 'Sleep timer' });
}

export const playIcon = (playing, cls = '') => icon(playing ? 'pause' : 'play', `icon--fill ${cls}`);
