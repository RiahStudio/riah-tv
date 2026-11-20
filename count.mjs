// Anonymous view counter, split three ways so the weekly email can tell people
// from automated visitors. Each page view sends exactly ONE Cloudflare Web
// Analytics beacon, to the counter for what the visit seems to be:
//   web   - a person in a browser (moved the mouse, touched, scrolled or pressed a key)
//   app   - the Riah TV Fire TV app (its WebView adds "RiahTVApp/<version>")
//   agent - automation: an AI agent's or robot's browser, or a page nobody
//           touched in its first 30 seconds on screen
// It's a best guess from the browser's own label and whether anyone touches the
// page. Nothing is stored and no cookies are set (privacy.html).
// Tokens are public by design: Cloudflare puts them in every page that counts.

export const TOKENS = {
  web: '4198d01bd8494b7f99af7608848c227e',
  app: '2776143042f04d718608f5390115faef',
  agent: '9016161f2f7f44988dea3d82bfad75d4',
};

// Browsers that say they're automated, crawlers, link previewers and AI agents.
const AGENT_UA = /HeadlessChrome|bot|crawl|spider|slurp|GPTBot|ChatGPT|OAI-SearchBot|Claude\/|anthropic|Perplexity|Bytespider|facebookexternalhit|Google-InspectionTool|Lighthouse|PhantomJS|Electron/i;

// How long a page can sit on screen with nobody touching it before it counts as automated.
export const AGENT_AFTER_MS = 30000;

// What a visit is from the first look alone: 'agent', 'app', or null (watch for a person).
export function kindOf({ ua = '', webdriver = false } = {}) {
  if (webdriver || AGENT_UA.test(ua)) return 'agent';
  if (/RiahTVApp\//.test(ua)) return 'app';
  return null;
}

function send(kind) {
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: TOKENS[kind] }));
  document.head.appendChild(s);
}

function watch() {
  let done = false;
  const decide = (kind) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    for (const e of EVENTS) removeEventListener(e, onInput, true);
    send(kind);
  };
  const EVENTS = ['pointermove', 'pointerdown', 'touchstart', 'wheel', 'keydown'];
  const onInput = (e) => { if (e.isTrusted) decide('web'); };
  for (const e of EVENTS) addEventListener(e, onInput, { capture: true, passive: true });
  // Only time on screen counts, so a tab opened in the background waits until it's looked at.
  let seen = 0;
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') seen += 1000;
    if (seen >= AGENT_AFTER_MS) decide('agent');
  }, 1000);
}

if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
  const kind = kindOf({ ua: navigator.userAgent, webdriver: navigator.webdriver === true });
  if (kind) send(kind);
  else watch();
}
