import type { Badge, BadgeTone } from '../session/marketplace';

// Badge pill colors per verdict tone.
const TONE_STYLE: Record<BadgeTone, { background: string; color: string }> = {
  match: { background: '#137333', color: '#ffffff' },
  skip: { background: 'rgba(179, 38, 30, 0.82)', color: '#ffffff' },
  review: { background: '#5f6368', color: '#ffffff' },
};

// Passed-tile wash: the settled tint that stays on the tile, and the
// stronger tint the fade starts from. Same green family as the MATCH badge
// so the two read as one verdict. Strong enough to survive busy product
// photos; the inset ring keeps the passed mark readable even where the
// wash alone would blend into the photo.
const MATCH_TINT = 'rgba(19, 115, 51, 0.25)';
const MATCH_TINT_FLASH = 'rgba(19, 115, 51, 0.5)';
const MATCH_RING = 'inset 0 0 0 2px rgba(19, 115, 51, 0.65)';

// Both overlays sit above tile-internal Facebook layers (photo counters,
// hover buttons), with the badge pill above the wash.
const TINT_Z_INDEX = '1000';
const BADGE_Z_INDEX = '1001';

export function paintBadge(anchor: HTMLAnchorElement, badge: Badge): void {
  anchor.dataset['dealHunterBadge'] = badge.id;
  if (window.getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
  }
  const tone = TONE_STYLE[badge.tone];
  const element = document.createElement('span');
  element.textContent = badge.text;
  element.dataset['dealHunterBadgeEl'] = badge.id;
  element.setAttribute('aria-hidden', 'true');
  element.style.position = 'absolute';
  element.style.top = '8px';
  element.style.left = '8px';
  element.style.zIndex = BADGE_Z_INDEX;
  element.style.pointerEvents = 'none';
  element.style.background = tone.background;
  element.style.color = tone.color;
  element.style.font =
    '600 11px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  element.style.letterSpacing = '0.02em';
  element.style.padding = '2px 8px';
  element.style.borderRadius = '999px';
  element.style.whiteSpace = 'nowrap';
  element.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.4)';
  anchor.appendChild(element);
  const reduceMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  if (!reduceMotion) {
    void element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
  }
  if (badge.tone !== 'match') return;
  paintWash(anchor, badge.id, reduceMotion);
}

// Passed tiles keep a green wash under the badge: it fades in from the
// stronger flash tint, then stays with the inset ring as the persistent
// passed marker. Every MATCH score gets it; SKIP and REVIEW stay
// label-only.
function paintWash(
  anchor: HTMLAnchorElement,
  id: string,
  reduceMotion: boolean,
): void {
  const host = washHostFor(anchor);
  const tint = document.createElement('span');
  tint.dataset['dealHunterTintEl'] = id;
  tint.setAttribute('aria-hidden', 'true');
  tint.style.position = 'absolute';
  tint.style.inset = '0';
  tint.style.zIndex = TINT_Z_INDEX;
  tint.style.pointerEvents = 'none';
  tint.style.background = MATCH_TINT;
  tint.style.boxShadow = MATCH_RING;
  tint.style.borderRadius = 'inherit';
  host.appendChild(tint);
  if (!reduceMotion) {
    void tint.animate(
      [
        { opacity: 0, background: MATCH_TINT_FLASH },
        { opacity: 1, background: MATCH_TINT },
      ],
      { duration: 300, easing: 'ease-out' },
    );
  }
}

// Hosts the wash on the image box when the tile has a photo, so the green
// covers the picture rather than the price/title text below it. Found
// structurally (the img's parent) instead of by Facebook's generated class
// names, which churn. Falls back to the whole tile when no image is in the
// DOM yet, e.g. skeleton tiles.
function washHostFor(anchor: HTMLAnchorElement): HTMLElement {
  const host = largestVisibleImage(anchor)?.parentElement ?? anchor;
  if (window.getComputedStyle(host).position === 'static') {
    host.style.position = 'relative';
  }
  return host;
}

// The tile's main photo: the largest rendered img. Tiles can hold hidden
// prefetch or decoy images (zero area) before the real photo; hosting the
// wash on one of those would paint it invisibly.
function largestVisibleImage(
  anchor: HTMLAnchorElement,
): HTMLImageElement | null {
  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  for (const image of anchor.querySelectorAll('img')) {
    const rect = image.getBoundingClientRect();
    if (rect.width * rect.height > bestArea) {
      best = image;
      bestArea = rect.width * rect.height;
    }
  }
  return best;
}

// Removes one tile's painted overlays: the badge pill (a direct child)
// and, on passed tiles, the green wash (nested in the image box when the
// tile has a photo). The tile becomes a wave candidate again.
export function clearBadge(anchor: HTMLAnchorElement): void {
  anchor
    .querySelectorAll(
      ':scope > span[data-deal-hunter-badge-el], span[data-deal-hunter-tint-el]',
    )
    .forEach((element) => element.remove());
  delete anchor.dataset['dealHunterBadge'];
}
