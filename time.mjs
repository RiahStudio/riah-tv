// Small timezone helpers (Intl only, no dependencies). All times are epoch seconds.

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a timezone. */
export function localParts(epochSec, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(epochSec * 1000))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** UTC offset in minutes (e.g. -420 for MST) at an instant. */
export function offsetMinutes(epochSec, tz) {
  const l = localParts(epochSec, tz);
  const asUtc = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) / 1000;
  return Math.round((asUtc - epochSec) / 60);
}

/** Epoch seconds for a wall-clock time in a timezone (handles DST). */
export function zonedEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0) / 1000;
  let t = guess - offsetMinutes(guess, tz) * 60;
  t = guess - offsetMinutes(t, tz) * 60; // second pass settles it across a DST edge
  const l = localParts(t, tz);
  if (l.h !== h || l.mi !== mi) {
    // The clock skipped this time (spring forward): use the instant it jumps to, so
    // 2:00 AM becomes 3:00 AM rather than falling back to 1:00 AM.
    t = Math.max(t, guess - offsetMinutes(t - 7200, tz) * 60);
  }
  return t;
}

/** Add days to a calendar date (no timezone involved). */
export function addDays({ y, mo, d }, n) {
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function isoUtc(epochSec) {
  return new Date(epochSec * 1000).toISOString();
}

/** "2026-11-15T06:00:00-07:00" style string in the given timezone. */
export function isoLocal(epochSec, tz) {
  const l = localParts(epochSec, tz);
  const off = offsetMinutes(epochSec, tz);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${l.y}-${p2(l.mo)}-${p2(l.d)}T${p2(l.h)}:${p2(l.mi)}:${p2(l.s)}${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
