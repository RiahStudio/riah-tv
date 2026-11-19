// Riah TV channel page. There is no server: this browser works out what's on from
// the clock and lineup.json (schedule.mjs), then plays it straight from where it
// lives (Internet Archive, Wikimedia Commons, or YouTube for Captain Mullet).
// On the web, video always starts muted. Sound, and the music under silent films,
// only come on after the viewer presses "Turn sound on".
// TV mode (?tv=1, used by the Fire TV app) fills the screen, runs on the remote,
// and starts with sound on; ?quiet=1 keeps it muted. See tv.js.
import { whatsOn, nextShows, itemsBetween, lookup, musicAt, blockBounds, channelDate, GRID } from './schedule.mjs';
import { addDays } from './time.mjs';
import { startTv } from './tv.js';

const VERSION = '0.2';
const RELEASED = '2026-11-17';
const MAX_LAG = 6 * 3600;  // the furthest a viewer can pause or skip back behind live
const GUIDE_HOURS = 6;
const PX_PER_MIN = 40;
const LIST_PAGE = 12;
const DRIFT = 4;           // seconds off the clock before we seek back into sync
const STUCK = 20;          // seconds without progress before trying another copy

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const link = (href, text) => { const a = el('a', '', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
const nowSec = () => Date.now() / 1000;
// The viewer's clock. It is live (lag 0) unless they paused or skipped back on the
// remote; the schedule always reads this clock, real-time checks read nowSec().
let lag = 0;
let pausedAt = null;
const viewNow = () => pausedAt ?? (nowSec() - lag);
const isPaused = () => pausedAt !== null;
const clockFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat([], { weekday: 'short' });
const clock = (epoch) => clockFmt.format(new Date(epoch * 1000));
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const runtime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`);
const setText = (e, text) => { if (e.textContent !== text) e.textContent = text; };
const blockName = (id) => GRID.find((b) => b.id === id)?.name || '';
const hostName = (url) => {
  const h = new URL(url).hostname;
  return h.endsWith('archive.org') ? 'Internet Archive' : h.endsWith('wikimedia.org') ? 'Wikimedia Commons' : h.endsWith('youtube.com') ? 'YouTube' : h;
};
const metaOf = (p) => [p.year, p.group, runtime(p.seconds), p.silent ? 'silent, with music' : null].filter(Boolean).join(' · ');

let lib = null;
let cur = null;            // { item, prog, block }
let curKey = null;
let soundOn = false;
let listLimit = LIST_PAGE;
let tickCount = 0;

// ---------- the video ----------
const video = $('video');
const music = $('music');
let sources = [];
let srcIndex = 0;
let loadedFor = null;      // program id whose copy is in the video element
let lastProgress = 0;
let needsTap = false;

function quietVideo() { video.muted = true; video.volume = 0; }
quietVideo();

/** Copies this browser can play, best first: phones and Save-Data get 480p or less. */
function pickSources(p) {
  const small = matchMedia('(max-width: 700px)').matches || navigator.connection?.saveData;
  const target = small ? 480 : 1080;
  const fits = (s) => (s.height || 9999) <= target;
  return p.sources
    .filter((s) => video.canPlayType(s.type) !== '')
    .sort((a, b) => (a.original - b.original)
      || (fits(b) - fits(a))
      || (fits(a) ? (b.height || 0) - (a.height || 0) : (a.height || 0) - (b.height || 0)));
}

function loadCopy(p) {
  const s = sources[srcIndex];
  setCaptions(p);
  loadedFor = p.id;
  lastProgress = nowSec();
  applySound();
  video.src = s.url;
  video.addEventListener('loadedmetadata', () => {
    if (cur?.prog?.id === p.id && cur.item.kind === 'program') { seekToClock(); tryPlay(video); }
    else video.currentTime = 0;
  }, { once: true });
}

function prepare(p) {
  if (!p || !p.sources || loadedFor === p.id) return;
  sources = pickSources(p);
  srcIndex = 0;
  if (sources.length) loadCopy(p, false);
}

// ---------- captions ----------
// One WebVTT per program in captions/ (made by tools/captions/). The video's own
// clock is the film's clock, so the cues line up after the seek to the live minute.
let captionsOn = false;
try { captionsOn = localStorage.getItem('riahtv-captions') === '1'; } catch { /* storage blocked */ }

function setCaptions(p) {
  const src = `captions/${encodeURIComponent(p.id)}.vtt`;
  if (video.querySelector('track')?.getAttribute('src') === src) return; // same film, another copy
  for (const t of video.querySelectorAll('track')) t.remove();
  const t = document.createElement('track');
  t.kind = 'captions';
  t.srclang = 'en';
  t.label = 'English';
  t.src = src;
  video.append(t);
  showCaptions();
}

function showCaptions() {
  for (const tt of video.textTracks) tt.mode = captionsOn ? 'showing' : 'hidden';
  const b = $('cc');
  b.textContent = captionsOn ? 'Captions off' : 'Captions on';
  b.setAttribute('aria-pressed', String(captionsOn));
  b.classList.toggle('is-on', captionsOn);
}

$('cc').addEventListener('click', () => {
  captionsOn = !captionsOn;
  try { localStorage.setItem('riahtv-captions', captionsOn ? '1' : '0'); } catch { /* storage blocked */ }
  showCaptions();
});
video.addEventListener('loadedmetadata', showCaptions); // a new copy can reset track modes
showCaptions();

function seekToClock() {
  const want = viewNow() - cur.item.start;
  const end = Number.isFinite(video.duration) ? video.duration - 0.5 : Infinity;
  video.currentTime = Math.max(0, Math.min(want, end));
}

function tryPlay(media) {
  if (isPaused()) return;
  const p = media.play();
  if (p) p.catch((err) => {
    if (err.name !== 'NotAllowedError' || media !== video) return;
    // TV mode starts with sound on. If this browser won't allow that, play muted.
    if (!video.muted) { setSound(false); tryPlay(video); } else askForTap();
  });
}

video.addEventListener('timeupdate', () => { if (!video.paused) lastProgress = nowSec(); });
// Still downloading or just finished a seek: slow, not stuck.
for (const ev of ['progress', 'seeked']) video.addEventListener(ev, () => { lastProgress = nowSec(); });
video.addEventListener('playing', () => { lastProgress = nowSec(); needsTap = false; $('screen-start').hidden = true; });
video.addEventListener('error', () => {
  if (!cur || cur.item.kind !== 'program' || video.getAttribute('src') !== sources[srcIndex]?.url) return;
  nextCopy();
});

function nextCopy() {
  srcIndex++;
  if (srcIndex < sources.length) loadCopy(cur.prog, true);
  else rightBack(cur.prog, "This film won't play here right now.");
}

function stopVideo() {
  if (!video.paused) video.pause();
}

// ---------- Captain Mullet (YouTube) ----------
let ytApi = null;
let yt = null;
let ytReady = false;
let specialSince = 0;      // when Captain Mullet was asked to play, to spot a blocked start
const YT_PLAYING = 1, YT_BUFFERING = 3;

function loadYouTube() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return ytApi;
}

async function playSpecial(item, sp) {
  stopVideo();
  showScreen(null);
  $('yt-wrap').hidden = false;
  const YT = await loadYouTube();
  if (cur?.item !== item) return;
  if (!YT) { rightBack(sp, "YouTube didn't load here.", sp.page); return; }
  const start = Math.max(0, Math.floor(viewNow() - item.start));
  specialSince = nowSec();
  if (!yt) {
    yt = new YT.Player('yt', {
      videoId: sp.youtube,
      playerVars: { autoplay: 1, mute: 1, controls: 0, playsinline: 1, rel: 0, start, fs: 0, iv_load_policy: 3, disablekb: 1 },
      events: {
        onReady: (e) => { ytReady = true; applySound(); if (cur?.item.kind === 'special' && !isPaused()) { e.target.seekTo(viewNow() - cur.item.start, true); e.target.playVideo(); } },
        onStateChange: (e) => { if (e.data === YT_PLAYING) { needsTap = false; $('screen-start').hidden = true; if ($('screen-label').textContent === 'Riah TV') showScreen(null); } },
        onError: () => { if (cur?.item.kind === 'special') rightBack(sp, "Captain Mullet won't play here right now.", sp.page); },
      },
    });
  } else if (ytReady) {
    yt.mute();
    yt.loadVideoById({ videoId: sp.youtube, startSeconds: start });
    applySound();
  }
}

function stopYouTube() {
  $('yt-wrap').hidden = true;
  if (yt && ytReady) yt.pauseVideo();
}

// ---------- music under silent films ----------
let musicFor = null;      // `${item.start}|${track.id}` now loaded
let musicSrc = 0;

function syncMusic() {
  const want = soundOn && !isPaused() && cur?.item.kind === 'program' && cur.prog?.silent;
  if (!want) {
    if (!music.paused) music.pause();
    setMusicCredit(null);
    return;
  }
  const m = musicAt(lib, cur.item, viewNow());
  if (!m) return;
  const key = `${cur.item.start}|${m.track.id}`;
  if (key !== musicFor) {
    musicFor = key;
    musicSrc = 0;
    loadMusic(m.track);
    setMusicCredit(m.track);
  } else if (music.readyState >= 1) {
    if (Math.abs(music.currentTime - m.offset) > DRIFT) music.currentTime = m.offset;
    if (music.paused) tryPlay(music);
  }
}

function loadMusic(track) {
  const playable = track.sources.filter((s) => music.canPlayType(s.type) !== '');
  const s = playable[musicSrc];
  if (!s) return;
  music.volume = 0.8;
  music.src = s.url;
  music.addEventListener('loadedmetadata', () => {
    const n = cur && musicAt(lib, cur.item, viewNow());
    if (n && n.track.id === track.id && soundOn) music.currentTime = n.offset;
    else music.pause();
  }, { once: true });
  // preload="none" fetches nothing until play() or load(); play() here also counts as
  // part of the viewer's tap when this runs from the sound button (iOS needs that).
  music.load();
  tryPlay(music);
}
music.addEventListener('error', () => {
  const m = cur && musicAt(lib, cur.item, viewNow());
  if (m && musicFor === `${cur.item.start}|${m.track.id}`) { musicSrc++; loadMusic(m.track); }
});

function setMusicCredit(track) {
  const p = $('music-credit');
  p.hidden = !track;
  p.replaceChildren();
  if (!track) return;
  p.append(`Music: ${track.title}, ${track.composer}. `, ...musicCredit(track));
}

/** A track's credit, linked to its page and to its licence. */
function musicCredit(track) {
  if (!track.credit) return [link(track.page, 'Public domain')];
  const lic = /(https?:\/\/creativecommons\.org[^\s)]*)/.exec(track.credit);
  const text = track.credit.replace(/\s*\(https?:[^)]*\)/, '').replace(/\s*https?:\S*/, '');
  const out = [link(track.page, text)];
  if (lic) out.push(' · ', link(lic[1], 'Licence'));
  return out;
}

// ---------- sound button ----------
function applySound() {
  const silent = !!cur?.prog?.silent;
  if (soundOn && cur?.item.kind === 'program' && !silent) { video.muted = false; video.volume = 1; }
  else quietVideo(); // a silent film's own track never plays; our music does instead
  if (yt && ytReady) { if (soundOn) { yt.unMute(); yt.setVolume(100); } else yt.mute(); }
  syncMusic();
}

function setSound(on) {
  soundOn = on;
  const b = $('sound');
  b.textContent = soundOn ? 'Mute' : 'Turn sound on';
  b.classList.toggle('is-on', soundOn);
  document.dispatchEvent(new CustomEvent('riahtv:sound', { detail: soundOn }));
  applySound();
}

function toggleSound() {
  setSound(!soundOn);
  if (cur?.item.kind === 'program' && video.paused && $('screen').hidden) tryPlay(video);
  if (cur?.item.kind === 'special' && yt && ytReady && soundOn && !isPaused()) yt.playVideo();
}
$('sound').addEventListener('click', toggleSound);

$('full').addEventListener('click', () => {
  const box = $('player');
  if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
  if (box.requestFullscreen) { box.requestFullscreen().catch(() => {}); return; }
  // iPhone can only make the video itself full screen, and only while a film is playing.
  if (video.webkitEnterFullscreen && cur?.item.kind === 'program' && !video.paused) {
    try { video.webkitEnterFullscreen(); } catch { /* not allowed right now */ }
  }
});

// ---------- the full-frame card ----------
function showScreen(label, title, meta, href) {
  const s = $('screen');
  s.hidden = !label;
  if (!label) return;
  setText($('screen-label'), label);
  setText($('screen-title'), title || '');
  const m = $('screen-meta');
  m.replaceChildren(meta || '');
  if (href) m.append(' ', link(href, `Watch on ${hostName(href)}`));
}

function askForTap() {
  needsTap = true;
  const s = $('screen');
  const ask = document.body.classList.contains('tv') ? 'Press Select on the remote to start.' : 'Your browser wants a tap before video plays.';
  if (s.hidden) showScreen('Riah TV', cur?.prog?.title || 'Live now', ask);
  $('screen-start').hidden = false;
}
$('screen-start').addEventListener('click', () => {
  $('screen-start').hidden = true;
  needsTap = false;
  const on = whatsOn(lib, viewNow());
  if (on.item.kind === 'special' && yt && ytReady && cur?.item.start === on.item.start) {
    showScreen(null);
    specialSince = nowSec();
    yt.playVideo(); // inside the tap, so the browser allows it
    applySound();
    return;
  }
  // Not forced: when the copy is already loaded, play() runs inside this tap.
  enter(on, false);
});

function rightBack(p, why, href) {
  stopVideo();
  stopYouTube();
  const nx = nextShows(lib, viewNow(), 1)[0];
  const then = nx ? ` Next at ${clock(nx.start)}: ${lookup(lib, nx.id)?.title}.` : '';
  showScreen("We'll be right back", p?.title || '', `${why}${then}`, href || p?.page);
}

// ---------- what's on ----------
function enter(on, force) {
  const it = on.item;
  cur = { item: it, prog: it.id ? lookup(lib, it.id) : null, block: on.block };
  if (it.kind === 'card' || it.kind === 'intermission') {
    stopVideo();
    stopYouTube();
    const nx = it.kind === 'card' ? lookup(lib, it.next) : lookup(lib, nextShows(lib, it.start, 1)[0]?.id);
    if (it.kind === 'card') showScreen('Up next', nx?.title, nx ? metaOf(nx) : '');
    else showScreen('Intermission', 'Riah TV', nx ? `Back at ${clock(it.end)} with ${nx.title}.` : '');
    if (nx?.youtube) loadYouTube(); else prepare(nx);
  } else if (it.kind === 'special') {
    playSpecial(it, cur.prog);
  } else {
    stopYouTube();
    showScreen(null);
    if (loadedFor === cur.prog.id && !force && sources[srcIndex] && !video.error) {
      lastProgress = nowSec();
      applySound();
      if (video.readyState >= 1) seekToClock();
      tryPlay(video); // before metadata too, so a tap on "Start watching" counts
    } else {
      sources = pickSources(cur.prog);
      srcIndex = 0;
      if (sources.length) { loadCopy(cur.prog, true); tryPlay(video); }
      else rightBack(cur.prog, "This browser can't play this film's format.");
    }
  }
  applySound();
}

function keepInSync() {
  if (!cur || needsTap || isPaused()) return;
  const want = viewNow() - cur.item.start;
  if (cur.item.kind === 'program' && $('screen').hidden) {
    if (video.readyState >= 1 && !video.seeking) {
      const end = Number.isFinite(video.duration) ? video.duration - 1 : Infinity;
      if (want < end && Math.abs(video.currentTime - want) > DRIFT) video.currentTime = want;
      if (video.paused && want < end) tryPlay(video);
    }
    if (!document.hidden && nowSec() - lastProgress > STUCK && !video.ended) nextCopy();
  }
  if (cur.item.kind === 'special' && yt && ytReady && yt.getCurrentTime && $('screen').hidden) {
    const st = yt.getPlayerState();
    const live = st === YT_PLAYING || st === YT_BUFFERING;
    // seekTo on a stopped YouTube player starts it, so only correct drift while it plays.
    if (live && want < yt.getDuration() - 1 && Math.abs(yt.getCurrentTime() - want) > DRIFT) yt.seekTo(want, true);
    if (!live && st !== 0 && !document.hidden && nowSec() - specialSince > 8) askForTap();
  }
}

// ---------- pause, skip and back to live (the TV remote) ----------
function pauseChannel() {
  if (isPaused() || !lib) return;
  pausedAt = viewNow();
  stopVideo();
  if (yt && ytReady) yt.pauseVideo();
  if (!music.paused) music.pause();
  tick();
}

/** Carry on from where the viewer paused, or move the viewer's clock by `shift` seconds. */
function resumeChannel(shift = 0) {
  if (!lib) return;
  const at = (pausedAt ?? viewNow()) + shift;
  pausedAt = null;
  lag = Math.min(MAX_LAG, Math.max(0, nowSec() - at));
  lastProgress = nowSec();
  needsTap = false;
  curKey = null; // re-enter what's on at the new time, even if it's the same program
  tick();
}
const togglePause = () => (isPaused() ? resumeChannel() : pauseChannel());
const skip = (sec) => resumeChannel(sec);
const goLive = () => resumeChannel(Infinity);

// ---------- Now card ----------
function renderNow(on) {
  const t = viewNow();
  const it = on.item;
  setText($('now-eyebrow'), `Now · ${on.block?.name || 'Riah TV'}`);
  const credit = $('now-credit');
  let p = cur.prog;
  let start = it.start, end = it.end;
  if (it.kind === 'card' || it.kind === 'intermission') {
    const nxItem = nextShows(lib, it.start, 1)[0];
    p = nxItem && lookup(lib, nxItem.id);
    setText($('now-title'), p ? p.title : 'Riah TV');
    setText($('now-meta'), p ? (it.kind === 'card' ? `Up next · ${metaOf(p)}` : `Intermission · then ${metaOf(p)}`) : '');
    $('bar-fill').style.width = '0%';
    $('bar').setAttribute('aria-valuenow', '0');
    setText($('now-ends'), nxItem ? `Starts ${clock(nxItem.start)}` : '');
    setText($('now-left'), `${mmss(end - t)} to go`);
    if (credit.dataset.for !== '') { credit.dataset.for = ''; credit.replaceChildren(); }
    return;
  }
  setText($('now-title'), p.title);
  setText($('now-meta'), metaOf(p));
  const pct = Math.min(100, Math.max(0, ((t - start) / (end - start)) * 100));
  $('bar-fill').style.width = `${pct}%`;
  $('bar').setAttribute('aria-valuenow', String(Math.round(pct)));
  setText($('now-ends'), `Ends ${clock(end)}`);
  setText($('now-left'), `${mmss(end - t)} left`);
  if (credit.dataset.for !== p.id) {
    credit.dataset.for = p.id;
    credit.replaceChildren();
    if (p.license) credit.append(`${p.credit}. `, link(p.license.url, 'Licence'), ' · ', link(p.page, hostName(p.page)));
    else if (p.rights?.basis === 'own-work') credit.append(`${p.credit}. `, link(p.page, hostName(p.page)));
    else credit.append('Public domain. ', link(p.page, `Source: ${hostName(p.page)}`));
  }
}

// ---------- Up next ----------
function nextMullet(t) {
  for (let d = channelDate(t), i = 0; i < 3; i++, d = addDays(d, 1)) {
    const b = blockBounds(d).find((x) => x.special);
    const sp = lookup(lib, b.special);
    if (t < b.startEpoch + sp.seconds) return { start: b.startEpoch, onNow: t >= b.startEpoch };
  }
  return null;
}

function renderNext() {
  const t = viewNow();
  const ol = $('next-list');
  ol.replaceChildren();
  for (const it of nextShows(lib, t, 5)) {
    const p = lookup(lib, it.id);
    const li = el('li');
    li.append(el('span', 't', clock(it.start)));
    const what = el('span', 'what');
    what.append(el('strong', '', p.title), el('span', '', `${runtime(p.seconds)} · ${blockName(it.block)}`));
    li.append(what);
    ol.append(li);
  }
  const m = nextMullet(t);
  const note = $('mullet-note');
  note.replaceChildren();
  if (m) {
    const when = m.onNow ? 'on now' : `next at ${clock(m.start)}${dayFmt.format(new Date(m.start * 1000)) !== dayFmt.format(new Date()) ? ` ${dayFmt.format(new Date(m.start * 1000))}` : ''}`;
    note.append(el('strong', '', 'Captain Mullet'), ` airs every night at 8 PM Mountain. It's ${when}.`);
  }
}

// ---------- program guide ----------
function renderGuide() {
  const t = viewNow();
  const from = t, to = t + GUIDE_HOURS * 3600;
  const progs = itemsBetween(lib, from, to).filter((it) => (it.kind === 'program' || it.kind === 'special') && !it.bumper);
  const d0 = channelDate(from);
  const blocks = [...blockBounds(d0), ...blockBounds(addDays(d0, 1))].filter((b) => b.endEpoch > from && b.startEpoch < to);
  const tzName = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || '';
  setText($('guide-note'), `Next ${GUIDE_HOURS} hours · ${tzName}`);

  // Phones: a list grouped by block.
  const ol = $('guide-list');
  ol.replaceChildren();
  let lastBlock = null;
  for (const it of progs.slice(0, listLimit)) {
    const p = lookup(lib, it.id);
    const li = el('li');
    if (it.block !== lastBlock) { li.className = 'block-start'; li.append(el('span', 'block-name', blockName(it.block))); lastBlock = it.block; }
    if (it.start <= t && t < it.end) li.classList.add('is-now');
    li.append(el('span', 't', clock(it.start)));
    const what = el('span', 'what');
    what.append(el('strong', '', p.title), el('span', '', [p.year, runtime(p.seconds)].filter(Boolean).join(' · ')));
    li.append(what);
    ol.append(li);
  }
  const more = $('guide-more');
  more.hidden = progs.length <= listLimit;
  more.textContent = `Show more (${progs.length - listLimit} left)`;

  // Desktop: a timeline that scrolls sideways.
  const tl = $('timeline');
  const scroll = tl.scrollLeft;
  tl.replaceChildren();
  const inner = el('div', 'tl-inner');
  const x = (epoch) => Math.max(0, ((epoch - from) / 60) * PX_PER_MIN);
  inner.style.width = `${GUIDE_HOURS * 60 * PX_PER_MIN}px`;
  for (let tk = Math.ceil(from / 1800) * 1800; tk < to; tk += 1800) {
    const tick = el('div', 'tl-tick', clock(tk));
    tick.style.left = `${x(tk)}px`;
    inner.append(tick);
  }
  for (const b of blocks) {
    const e = el('div', 'tl-block', b.name);
    e.style.left = `${x(b.startEpoch)}px`;
    e.style.width = `${x(Math.min(b.endEpoch, to)) - x(b.startEpoch)}px`;
    inner.append(e);
  }
  for (const it of progs) {
    const p = lookup(lib, it.id);
    const left = x(it.start), width = x(Math.min(it.end, to)) - left;
    const e = el('div', 'tl-prog');
    e.style.left = `${left}px`;
    e.style.width = `${Math.max(2, width - 2)}px`;
    const label = `${p.title}, ${clock(it.start)} to ${clock(it.end)}`;
    e.title = label;
    if (width < 90) { e.classList.add('narrow'); e.setAttribute('role', 'group'); e.setAttribute('aria-label', label); }
    if (it.start <= t && t < it.end) e.classList.add('is-now');
    e.append(document.createTextNode(p.title), el('small', '', `${clock(it.start)} · ${runtime(p.seconds)}`));
    inner.append(e);
  }
  const line = el('div', 'tl-now');
  line.style.left = `${x(t)}px`;
  line.setAttribute('aria-hidden', 'true');
  inner.append(line);
  tl.append(inner);
  tl.scrollLeft = scroll;
}
$('guide-more').addEventListener('click', () => { listLimit += LIST_PAGE; renderGuide(); });

// ---------- credits ----------
function renderCredits() {
  const ul = $('credits-programs');
  const all = [...lib.specials, ...(lib.bumpers || []), ...lib.programs].sort((a, b) => a.title.localeCompare(b.title));
  for (const p of all) {
    const li = el('li');
    li.append(el('strong', '', p.title), p.year ? ` (${p.year}). ` : '. ');
    if (p.license) li.append(`${p.credit}, `, link(p.license.url, 'licence'), '. ');
    else if (p.rights?.basis === 'own-work') li.append(`${p.credit}. `);
    else li.append('Public domain. ');
    li.append(link(p.page, hostName(p.page)));
    ul.append(li);
  }
  const mu = $('credits-music');
  for (const tr of [...lib.music].sort((a, b) => a.composer.localeCompare(b.composer) || a.title.localeCompare(b.title))) {
    const li = el('li');
    li.append(`${tr.title}, ${tr.composer}. `);
    li.append(...musicCredit(tr));
    mu.append(li);
  }
}

// ---------- clock ----------
function tick() {
  const on = whatsOn(lib, viewNow());
  if (!on) return;
  const key = `${on.item.start}|${on.item.kind}`;
  if (key !== curKey) {
    curKey = key;
    enter(on);
    renderNext();
    renderGuide();
  }
  renderNow(on);
  renderLive();
  syncMusic();
  if (++tickCount % 5 === 0) keepInSync();
  if (tickCount % 60 === 0) { renderGuide(); renderNext(); }
}

function renderLive() {
  const behind = isPaused() ? nowSec() - pausedAt : lag;
  const b = $('live');
  b.classList.toggle('is-behind', behind >= 2);
  const label = isPaused() ? 'Paused' : behind >= 2 ? `${mmss(behind)} behind live` : 'Live';
  if (b.lastChild?.textContent !== label) b.lastChild.textContent = label;
  document.dispatchEvent(new CustomEvent('riahtv:tick', { detail: { label, behind, paused: isPaused() } }));
}

// Browsers may pause video in a background tab; on return, catch up to the clock.
document.addEventListener('visibilitychange', () => { if (!document.hidden && lib) { lastProgress = nowSec(); tick(); keepInSync(); } });

async function start() {
  const stamp = `Riah TV v${VERSION} · ${RELEASED}`;
  try {
    const r = await fetch('lineup.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    lib = await r.json();
  } catch {
    const n = $('player-note');
    n.textContent = "Can't load the schedule. Reload to try again.";
    n.hidden = false;
    return;
  }
  setText($('foot-version'), `${stamp} · lineup ${lib.built}`);
  setText($('slug-version'), `Riah TV v${VERSION}`);
  $('foot-note').textContent = 'Times are shown in your local time. Captain Mullet airs every night at 8 PM Mountain.';
  renderCredits();
  const q = new URLSearchParams(location.search);
  if (q.get('tv') === '1' || /\bAFT[A-Z0-9]/.test(navigator.userAgent)) {
    startTv({
      lib, stamp: `Riah TV v${VERSION}`, viewNow, isPaused, togglePause, pauseChannel, resumeChannel, skip, goLive,
      toggleSound, soundOn: () => soundOn, clock, runtime, metaOf, blockName,
    });
    if (q.get('quiet') !== '1') setSound(true);
  }
  tick();
  setInterval(tick, 1000);
}
start();
