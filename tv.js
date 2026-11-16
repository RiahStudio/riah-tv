// Riah TV on a TV. The Fire TV app loads the channel with ?tv=1 (Fire TV browsers
// are also spotted by their "AFT" user agent). The picture fills the screen, and a
// remote runs everything: any key shows the info bar, the arrows move between its
// buttons and the guide, Select presses, Play/Pause pauses the channel, Rewind and
// Fast Forward move 30 seconds, and Back closes whatever is open. With nothing open,
// Back is left to the app, which closes (window.riahTV.back() returns false).
import { nextShows, lookup } from './schedule.mjs';

const HUD_MS = 7000;
const SKIP = 30;
const GUIDE_ROWS = 14;

let api;
let hud;
let guide;
let hideTimer = 0;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const setText = (e, text) => { if (e.textContent !== text) e.textContent = text; };

const BY_KEY = {
  Enter: 'select', NumpadEnter: 'select', Select: 'select',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Escape: 'back', Backspace: 'back', GoBack: 'back', BrowserBack: 'back',
  MediaPlayPause: 'playpause', ' ': 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'pause',
  MediaFastForward: 'ff', MediaTrackNext: 'ff', MediaRewind: 'rew', MediaTrackPrevious: 'rew',
  ContextMenu: 'menu',
};
// Older TV browsers only send key codes (Android numbers included, for safety).
const BY_CODE = {
  13: 'select', 23: 'select', 37: 'left', 38: 'up', 39: 'right', 40: 'down', 21: 'left', 19: 'up', 22: 'right', 20: 'down',
  27: 'back', 8: 'back', 4: 'back', 179: 'playpause', 85: 'playpause', 126: 'play', 127: 'pause',
  228: 'ff', 90: 'ff', 227: 'rew', 89: 'rew', 82: 'menu', 93: 'menu',
};

export function startTv(channel) {
  api = channel;
  document.body.classList.add('tv');
  build();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('riahtv:tick', render);
  document.addEventListener('riahtv:sound', render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  // The Android app calls these: back() for the Back button (false means "close the
  // app"), key() for remote buttons it catches itself, and pause() when the app is
  // sent to the background or the TV is unplugged.
  window.riahTV = { back: () => act('back'), key: (name) => act(name), pause: () => { api.pauseChannel(); showHud(); } };
  keepAwake();
  showHud();
}

function build() {
  hud = el('div', 'tv-hud');
  hud.id = 'tv-hud';
  hud.innerHTML = `
    <div class="tv-top">
      <div class="riah-lockup"><span class="riah-wordmark">Riah</span> <span class="riah-product-name">TV</span></div>
      <span class="tv-live" id="tv-live"><i aria-hidden="true"></i><span>Live</span></span>
      <span class="tv-clock" id="tv-clock"></span>
    </div>
    <div class="tv-bottom">
      <p class="tv-eyebrow" id="tv-eyebrow"></p>
      <h2 class="tv-title" id="tv-title"></h2>
      <p class="tv-meta" id="tv-meta"></p>
      <div class="tv-bar"><span id="tv-bar-fill"></span></div>
      <p class="tv-times"><span id="tv-ends"></span><span id="tv-next"></span></p>
      <div class="tv-actions">
        <button class="tv-btn tv-focus" type="button" data-act="playpause" id="tv-pause">Pause</button>
        <button class="tv-btn tv-focus" type="button" data-act="menu">Guide</button>
        <button class="tv-btn tv-focus" type="button" data-act="sound" id="tv-sound">Sound on</button>
        <button class="tv-btn tv-focus" type="button" data-act="live" id="tv-golive" hidden>Back to live</button>
      </div>
      <p class="tv-hint">Play/Pause pauses the channel &middot; Rewind and Fast Forward move ${SKIP} seconds &middot; Back hides this</p>
    </div>`;
  guide = el('aside', 'tv-guide');
  guide.id = 'tv-guide';
  guide.hidden = true;
  guide.setAttribute('aria-label', 'Coming up');
  guide.innerHTML = `
    <h2 class="tv-guide-title">Coming up</h2>
    <ol class="tv-guide-list" id="tv-guide-list"></ol>
    <p class="tv-guide-note">Captain Mullet airs every night at 8 PM Mountain.</p>`;
  $('player').append(hud, guide);
  hud.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const what = b.dataset.act;
    if (what === 'sound') api.toggleSound();
    else if (what === 'live') api.goLive();
    else act(what);
    showHud();
  });
  guide.addEventListener('click', (e) => {
    const b = e.target.closest('.tv-prog');
    if (b) { b.classList.toggle('is-open'); b.setAttribute('aria-expanded', String(b.classList.contains('is-open'))); showHud(); }
  });
}

// ---------- the info bar ----------
function showHud() {
  hud.hidden = false;
  document.body.classList.add('tv-awake');
  if (!hud.contains(document.activeElement) && !guide.contains(document.activeElement)) focus($('tv-pause'));
  render();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideHud, HUD_MS);
}

function hideHud(force) {
  // Paused or browsing the guide: stay up until the viewer says otherwise.
  if (!force && (api.isPaused() || !guide.hidden)) { hideTimer = setTimeout(hideHud, HUD_MS); return; }
  clearTimeout(hideTimer);
  hud.hidden = true;
  toggleGuide(false);
  document.body.classList.remove('tv-awake');
  document.activeElement?.blur?.();
}

function render() {
  if (!hud || hud.hidden) return;
  // The page's own Now card already has the words; the TV bar shows the same.
  setText($('tv-eyebrow'), $('now-eyebrow').textContent);
  setText($('tv-title'), $('now-title').textContent);
  setText($('tv-meta'), $('now-meta').textContent);
  $('tv-bar-fill').style.width = $('bar-fill').style.width;
  setText($('tv-ends'), [$('now-ends').textContent, $('now-left').textContent].filter((s) => s.trim()).join(' · '));
  const nx = nextShows(api.lib, api.viewNow(), 1)[0];
  setText($('tv-next'), nx ? `Next ${api.clock(nx.start)}: ${lookup(api.lib, nx.id).title}` : '');
  setText($('tv-clock'), `${api.clock(Date.now() / 1000)} · ${api.stamp}`);
  const live = $('live');
  setText($('tv-live').lastChild, live.lastChild.textContent);
  $('tv-live').classList.toggle('is-behind', live.classList.contains('is-behind'));
  setText($('tv-pause'), api.isPaused() ? 'Play' : 'Pause');
  setText($('tv-sound'), api.soundOn() ? 'Sound off' : 'Sound on');
  const behind = live.classList.contains('is-behind');
  if ($('tv-golive').hidden === behind) {
    $('tv-golive').hidden = !behind;
    if (!behind && document.activeElement === $('tv-golive')) focus($('tv-pause'));
  }
}

// ---------- the guide ----------
function toggleGuide(open = guide.hidden) {
  if (open === !guide.hidden) return;
  guide.hidden = !open;
  document.body.classList.toggle('tv-guide-open', open);
  if (!open) { if (guide.contains(document.activeElement)) focus($('tv-pause')); return; }
  const ol = $('tv-guide-list');
  ol.replaceChildren();
  for (const it of nextShows(api.lib, api.viewNow(), GUIDE_ROWS)) {
    const p = lookup(api.lib, it.id);
    const li = el('li');
    const b = el('button', 'tv-prog tv-focus');
    b.type = 'button';
    b.setAttribute('aria-expanded', 'false');
    const credit = p.license ? p.credit : p.rights?.basis === 'own-work' ? p.credit : 'Public domain';
    b.append(
      el('span', 'tv-prog-time', api.clock(it.start)),
      el('span', 'tv-prog-title', p.title),
      el('span', 'tv-prog-sub', api.metaOf(p)),
      el('span', 'tv-prog-more', `${api.blockName(it.block)}. ${credit}.`),
    );
    li.append(b);
    ol.append(li);
  }
  focus(ol.querySelector('.tv-prog'));
}

// ---------- the remote ----------
function onKey(e) {
  const name = BY_KEY[e.key] || BY_CODE[e.keyCode];
  if (!name) { showHud(); return; }
  e.preventDefault();
  e.stopPropagation();
  act(name);
}

/** Does what a remote button means right now. Returns false only when Back has nothing left to close. */
function act(name) {
  const open = !hud.hidden;
  switch (name) {
    case 'playpause': api.togglePause(); break;
    case 'play': if (api.isPaused()) api.togglePause(); break;
    case 'pause': api.pauseChannel(); break;
    case 'ff': api.skip(SKIP); break;
    case 'rew': api.skip(-SKIP); break;
    case 'menu': if (!open) showHud(); toggleGuide(); break;
    case 'back':
      if (!guide.hidden) { toggleGuide(false); break; }
      if (open) { hideHud(true); return true; }
      return false;
    case 'select': {
      const f = document.activeElement;
      const card = $('screen-start');
      if (!card.hidden) { card.click(); break; }
      if (open && f?.classList.contains('tv-focus')) f.click();
      break;
    }
    default:
      if (open) move(name);
  }
  showHud();
  return true;
}

function visible(e) {
  if (e.closest('[hidden]')) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Spatial focus: the nearest button in the direction pressed. */
function move(dir) {
  const all = [...document.querySelectorAll('.tv-focus')].filter(visible);
  const from = document.activeElement?.classList.contains('tv-focus') ? document.activeElement : null;
  if (!from) { focus(all[0]); return; }
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const e of all) {
    if (e === from) continue;
    const r = e.getBoundingClientRect();
    const dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
    const main = { left: -dx, right: dx, up: -dy, down: dy }[dir];
    const side = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (main <= 1) continue;
    const score = main + side * 2;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  if (best) focus(best);
}

function focus(e) {
  if (!e) return;
  e.focus({ preventScroll: true });
  e.scrollIntoView?.({ block: 'nearest' });
}

// ---------- keep the screen on while the channel plays ----------
async function keepAwake() {
  try { await navigator.wakeLock?.request('screen'); } catch { /* not allowed here; the Fire TV app keeps the screen on itself */ }
}
