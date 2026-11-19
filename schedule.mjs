// Riah TV schedule. Pure functions only: the same lineup and the same clock give
// every viewer the same thing, so each browser works out what's on by itself and
// no server is needed. Node tests import this file too.
import { localParts, zonedEpoch, addDays } from './time.mjs';

export const TZ = 'America/Denver';
export const CARD = 20;          // "Up next" card before each program, seconds
export const HALF_HOUR = 1800;

// The daily grid, in Denver time. A channel day runs 6 AM to 6 AM.
export const GRID = [
  { id: 'morning',   name: 'Morning Classic Comedy', start: '06:00', pool: 'shorts' },
  { id: 'showcase',  name: 'Comedy Showcase',        start: '10:00', pool: 'comedy', features: 2 },
  { id: 'makers',    name: 'Makers & Oddities',      start: '14:00', pool: 'makers' },
  { id: 'cinema',    name: 'Classic Comedy Cinema',  start: '17:00', pool: 'comedy', features: 1 },
  { id: 'mullet',    name: 'Captain Mullet',         start: '20:00', pool: 'shorts', special: 'captain-mullet-pilot' },
  { id: 'prime',     name: 'Prime Time Comedy',      start: '20:30', pool: 'comedy', features: 1 },
  { id: 'late',      name: 'Late Night',             start: '23:00', pool: 'late', features: 1 },
  { id: 'overnight', name: 'Overnight',              start: '02:00', pool: 'all', features: 1 },
];
const DAY_START = '06:00';

// ---------- deterministic randomness ----------
function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed) {
  let a = hash(String(seed));
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- dates ----------
const ymd = ({ y, mo, d }) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const hm = (s) => s.split(':').map(Number);

/** The channel day (6 AM to 6 AM Denver) an instant falls in. */
export function channelDate(epoch) {
  const l = localParts(epoch, TZ);
  const [h0, m0] = hm(DAY_START);
  const date = { y: l.y, mo: l.mo, d: l.d };
  return (l.h * 60 + l.mi < h0 * 60 + m0) ? addDays(date, -1) : date;
}

/** Block boundaries for a channel day, as epochs. Each block ends where the next begins. */
export function blockBounds(date) {
  const at = (t) => {
    const [h, m] = hm(t);
    const [h0] = hm(DAY_START);
    const d = h < h0 ? addDays(date, 1) : date; // after midnight belongs to the next calendar date
    return zonedEpoch(d.y, d.mo, d.d, h, m, TZ);
  };
  const starts = GRID.map((b) => at(b.start));
  const next = addDays(date, 1);
  const [h0, m0] = hm(DAY_START);
  const dayEnd = zonedEpoch(next.y, next.mo, next.d, h0, m0, TZ);
  return GRID.map((b, i) => ({ ...b, startEpoch: starts[i], endEpoch: i + 1 < GRID.length ? starts[i + 1] : dayEnd }));
}

// ---------- building a block ----------
const FILLER_MAX = 8 * 60; // shorts this long or less can pad a gap

/**
 * Fills [start, end) from the block's pool. `day` is shared across the day's
 * blocks so titles spread out: the least-played title today goes first, and
 * the two most recent titles never come straight back.
 */
export function buildBlock(lib, block, dateKey, day = newDayState()) {
  const rand = rng(`${dateKey}|${block.id}`);
  const items = [];
  let t = block.startEpoch;
  const end = block.endEpoch;
  const recent = day.recent;
  const plays = day.plays;
  const seen = (id) => recent.includes(id);
  const aired = (id) => { recent.push(id); if (recent.length > 2) recent.shift(); plays.set(id, (plays.get(id) || 0) + 1); };

  const push = (kind, seconds, extra) => {
    items.push({ kind, start: t, end: t + seconds, seconds, block: block.id, ...extra });
    t += seconds;
  };
  // A program with a Night Crew intro (lineup.bumpers, before: its id) gets the intro in place of
  // its up-next card; the intro ends on its own up-next card, so it does the same job.
  const lead = (p) => introFor(lib, p.id)?.seconds || CARD;
  const air = (p) => {
    const intro = introFor(lib, p.id);
    if (intro) push('program', intro.seconds, { id: intro.id, bumper: true });
    else push('card', CARD, { next: p.id });
    push('program', p.seconds, { id: p.id });
    aired(p.id);
  };

  const special = block.special && lib.specials.find((s) => s.id === block.special);
  if (special && special.seconds <= end - t) { push('special', special.seconds, { id: special.id }); aired(special.id); }

  // A fixed shuffled rank per block breaks ties, so the order changes day to day.
  const rank = new Map(shuffle(lib.programs, rand).map((p, i) => [p.id, i]));
  const best = (list) => list.reduce((x, y) => {
    const px = plays.get(x.id) || 0, py = plays.get(y.id) || 0;
    return py < px || (py === px && rank.get(y.id) < rank.get(x.id)) ? y : x;
  });
  const pool = block.pool === 'all' ? lib.programs : lib.programs.filter((p) => p.pools.includes(block.pool));
  const fillers = lib.programs.filter((p) => p.seconds <= FILLER_MAX && (block.pool === 'all' || p.pools.includes(block.pool) || p.pools.includes('shorts')));

  // Pads a gap with short programs, then an intermission card for what's left.
  const fillGap = (gap) => {
    const stop = t + gap;
    for (;;) {
      const fits = fillers.filter((p) => lead(p) + p.seconds <= stop - t && !seen(p.id));
      if (!fits.length) break;
      air(best(fits));
    }
    if (stop > t) push('intermission', stop - t, {});
  };

  // Features start on :00 or :30 (their up-next card, or intro, begins on the mark).
  const padFor = (p) => (p.kind === 'feature' ? Math.ceil(t / HALF_HOUR) * HALF_HOUR - t : 0);
  const fits = (p) => !seen(p.id) && padFor(p) + lead(p) + p.seconds <= end - t;

  let features = 0;
  let lastFeatureEnd = -Infinity;
  while (end - t > 0) {
    const ok = pool.filter(fits);
    if (!ok.length) { fillGap(end - t); break; }
    // Anchor the block with its features, spaced at least half an hour apart.
    const wantFeature = features < (block.features || 0) && t - lastFeatureEnd >= HALF_HOUR;
    const feats = ok.filter((p) => p.kind === 'feature');
    const shorts = ok.filter((p) => p.kind !== 'feature');
    const pick = wantFeature && feats.length ? best(feats) : best(shorts.length && (block.features || 0) > 0 ? shorts : ok);
    const pad = padFor(pick);
    if (pad > 0) fillGap(pad);
    air(pick);
    if (pick.kind === 'feature') { features++; lastFeatureEnd = t; }
  }
  return items;
}

export function newDayState(prevId = null) {
  return { recent: [prevId], plays: new Map() };
}

// ---------- days and lookups ----------
const dayCache = new Map();

/** Every item of one channel day, in order, back to back. */
export function buildDay(lib, date) {
  const key = ymd(date);
  const cached = dayCache.get(lib)?.get(key);
  if (cached) return cached;
  const items = [];
  const blocks = blockBounds(date);
  const state = newDayState();
  blocks.forEach((b, i) => {
    // A bumper for the next block's special takes the last seconds of this block,
    // so the special itself still starts exactly on its mark.
    const bump = blocks[i + 1]?.special && bumperFor(lib, blocks[i + 1].special);
    const end = bump ? b.endEpoch - bump.seconds : b.endEpoch;
    items.push(...buildBlock(lib, { ...b, endEpoch: end }, key, state));
    if (bump) items.push({ kind: 'program', start: end, end: b.endEpoch, seconds: bump.seconds, block: b.id, id: bump.id, bumper: true });
  });
  const day = { date: key, blocks, items };
  if (!dayCache.has(lib)) dayCache.set(lib, new Map());
  const m = dayCache.get(lib);
  m.set(key, day);
  if (m.size > 8) m.delete(m.keys().next().value);
  return day;
}

/** Items overlapping [from, to), across channel days. */
export function itemsBetween(lib, from, to) {
  const out = [];
  let date = channelDate(from);
  for (let guard = 0; guard < 10; guard++) {
    const day = buildDay(lib, date);
    for (const it of day.items) if (it.end > from && it.start < to) out.push(it);
    if (!day.items.length || day.items[day.items.length - 1].end >= to) break;
    date = addDays(date, 1);
  }
  return out;
}

/** What's on at an instant, and how far into it we are. */
export function whatsOn(lib, epoch) {
  const day = buildDay(lib, channelDate(epoch));
  const item = day.items.find((it) => it.start <= epoch && epoch < it.end);
  const block = day.blocks.find((b) => b.id === item?.block);
  return item ? { item, offset: epoch - item.start, block } : null;
}

/** The program, special or bumper an item is about (cards point at what's next). */
export function lookup(lib, id) {
  return lib.programs.find((p) => p.id === id) || lib.specials.find((s) => s.id === id)
    || (lib.bumpers || []).find((b) => b.id === id) || null;
}

/** The on-air bumper (our own clip, lineup.bumpers) that leads into a special, if the special is in this lineup. */
export function bumperFor(lib, specialId) {
  if (!lib.specials.some((s) => s.id === specialId)) return null;
  return (lib.bumpers || []).find((b) => b.before === specialId) || null;
}

/** The on-air intro (a bumper whose `before` is a regular program) that plays in place of that program's card. */
export function introFor(lib, programId) {
  if (lib.specials.some((s) => s.id === programId)) return null;
  return (lib.bumpers || []).find((b) => b.before === programId) || null;
}

/** The next real program after an instant (skips cards and bumpers). */
export function nextShows(lib, epoch, count) {
  const out = [];
  for (const it of itemsBetween(lib, epoch, epoch + 12 * 3600)) {
    if ((it.kind === 'program' || it.kind === 'special') && !it.bumper && it.start > epoch) out.push(it);
    if (out.length >= count) break;
  }
  return out;
}

// ---------- music under silent films ----------
/** Which accompaniment track plays at an instant during a silent program, and where in it. */
export function musicAt(lib, item, epoch) {
  if (!lib.music?.length) return null;
  const late = item.block === 'late' || item.block === 'overnight';
  const moods = late ? ['spooky', 'gentle', 'spooky', 'upbeat'] : ['upbeat', 'upbeat', 'gentle', 'upbeat'];
  const rand = rng(`music|${item.start}|${item.id}`);
  const byMood = Object.fromEntries(['upbeat', 'gentle', 'spooky'].map((m) => [m, shuffle(lib.music.filter((t) => t.mood === m), rand)]));
  let t = item.start;
  for (let i = 0; i < 500; i++) {
    const list = byMood[moods[i % moods.length]];
    const track = list.length ? list[Math.floor(i / moods.length) % list.length] : lib.music[i % lib.music.length];
    if (epoch < t + track.seconds) return { track, offset: epoch - t };
    t += track.seconds;
  }
  return null;
}
