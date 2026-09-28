import { browser } from 'wxt/browser';
import { MarketplaceSession, itemId } from '../src/session/marketplace';
import type {
  Badge,
  BadgeTone,
  TileSnapshot,
} from '../src/session/marketplace';
import { createOpenRouterGateway } from '../src/gateway/openrouter';
import { briefStore } from '../src/stores/brief';
import type { BriefState } from '../src/stores/brief';
import { hasKey, keyStore } from '../src/stores/key';
import { VIEW_UPDATED, isGetView } from '../src/messaging';
import type { ViewPayload } from '../src/messaging';

// Marketplace grid watcher. Reads item tiles, sends them through the session
// in debounced waves, and paints the verdict badges. It never clicks,
// scrolls, types, or messages: DOM reads plus badge overlays only.
export default defineContentScript({
  matches: [
    '*://www.facebook.com/marketplace*',
    '*://web.facebook.com/marketplace*',
  ],
  excludeMatches: [
    '*://www.facebook.com/marketplace/you*',
    '*://www.facebook.com/marketplace/create*',
    '*://www.facebook.com/marketplace/inbox*',
    '*://web.facebook.com/marketplace/you*',
    '*://web.facebook.com/marketplace/create*',
    '*://web.facebook.com/marketplace/inbox*',
  ],
  main(ctx) {
    if (!isWatchedRoute(window.location.pathname)) return;

    const session = new MarketplaceSession(createOpenRouterGateway());
    const badges = new Map<string, Badge>();
    // Attempted but unpainted ids (failed call or omitted answers). They stay
    // out of later automatic waves: a failed chunk never retries by itself.
    // #6 Rescore will clear this set on explicit shopper request.
    const failed = new Set<string>();
    let running = false;
    let queued: TileSnapshot[] = [];

    // A burst of newly appeared tiles collapses into one wave. The interval
    // is ours to choose; 400ms covers fast scrolls without feeling laggy.
    const DEBOUNCE_MS = 400;
    let timer: ReturnType<typeof setTimeout> | null = null;

    runWave(collectSnapshots());

    const observer = new MutationObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runWave(collectSnapshots());
      }, DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const unwatchBrief = briefStore.watch(async (brief) => {
      await refreshAfterStoreChange(brief);
    });
    const unwatchKey = keyStore.watch(async () => {
      await refreshAfterStoreChange(await briefStore.getValue());
    });

    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isGetView(message)) return undefined;
      return (async (): Promise<ViewPayload> => {
        const brief = await briefStore.getValue();
        return { panel: session.preview(brief, await hasKey()), brief };
      })();
    });

    ctx.onInvalidated(() => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      unwatchBrief();
      unwatchKey();
    });

    function collectSnapshots(): TileSnapshot[] {
      const snapshots: TileSnapshot[] = [];
      for (const anchor of tileAnchors()) {
        if (anchor.dataset['dealHunterBadge'] !== undefined) continue;
        const id = itemId(anchor.href);
        if (id === null || failed.has(id)) continue;
        const known = badges.get(id);
        if (known !== undefined) {
          // Remounted tile: repaint from memory, never resend.
          paintBadge(anchor, known);
          continue;
        }
        snapshots.push({ href: anchor.href, name: accessibleName(anchor) });
      }
      return snapshots;
    }

    async function runWave(snapshots: TileSnapshot[]): Promise<void> {
      queued.push(...snapshots);
      if (running) return;
      running = true;
      try {
        while (queued.length > 0) {
          const batch = queued;
          queued = [];
          const fresh = batch.filter((snapshot) => {
            const id = itemId(snapshot.href);
            return id !== null && !badges.has(id);
          });
          if (fresh.length === 0) continue;
          if (!isWatchedRoute(window.location.pathname)) return;
          const brief = await briefStore.getValue();
          const result = await session.judgeWave(brief, fresh, await hasKey());
          for (const id of result.unpainted) failed.add(id);
          for (const badge of result.badges) {
            badges.set(badge.id, badge);
            paintBadges(badge);
          }
          pushView({ panel: result.panel, brief });
        }
      } finally {
        running = false;
      }
    }

    async function refreshAfterStoreChange(brief: BriefState): Promise<void> {
      // A new key or a first query unlocks the tiles already on screen; a
      // changed query does not rescore (#4 owns that), it only refreshes
      // the panel's status line.
      pushView({ panel: session.preview(brief, await hasKey()), brief });
      await runWave(collectSnapshots());
    }

    function pushView(view: ViewPayload): void {
      void browser.runtime
        .sendMessage({ type: VIEW_UPDATED, view })
        .catch(() => {});
    }

    function paintBadges(badge: Badge): void {
      for (const anchor of tileAnchors()) {
        if (anchor.dataset['dealHunterBadge'] !== undefined) continue;
        if (itemId(anchor.href) !== badge.id) continue;
        paintBadge(anchor, badge);
      }
    }

  },
});

function isWatchedRoute(pathname: string): boolean {
  if (!pathname.startsWith('/marketplace')) return false;
  const segment = pathname
    .slice('/marketplace'.length)
    .split('/')
    .filter((part) => part !== '')[0];
  return segment !== 'you' && segment !== 'create' && segment !== 'inbox';
}

function tileAnchors(): HTMLAnchorElement[] {
  const anchors: HTMLAnchorElement[] = [];
  for (const element of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
    if (element instanceof HTMLAnchorElement) anchors.push(element);
  }
  return anchors;
}

function accessibleName(anchor: HTMLAnchorElement): string {
  const label = anchor.getAttribute('aria-label') ?? anchor.textContent ?? '';
  return label.replace(/\s+/g, ' ').trim();
}

const TONE_STYLE: Record<BadgeTone, { background: string; color: string }> = {
  match: { background: '#137333', color: '#ffffff' },
  skip: { background: 'rgba(179, 38, 30, 0.82)', color: '#ffffff' },
  review: { background: '#5f6368', color: '#ffffff' },
};

function paintBadge(anchor: HTMLAnchorElement, badge: Badge): void {
  anchor.dataset['dealHunterBadge'] = badge.id;
  if (window.getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
  }
  const tone = TONE_STYLE[badge.tone];
  const element = document.createElement('span');
  element.textContent = badge.text;
  element.setAttribute('aria-hidden', 'true');
  element.style.position = 'absolute';
  element.style.top = '8px';
  element.style.left = '8px';
  element.style.zIndex = '1000';
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
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    void element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
  }
}
