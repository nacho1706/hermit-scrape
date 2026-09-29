import { browser } from 'wxt/browser';
import { MarketplaceSession, briefHashFor, itemId } from '../src/session/marketplace';
import type { Badge, TileSnapshot } from '../src/session/marketplace';
import { clearBadge, paintBadge } from '../src/dom/marketplace-badges';
import { createOpenRouterGateway } from '../src/gateway/openrouter';
import { briefStore } from '../src/stores/brief';
import type { BriefState } from '../src/stores/brief';
import { hasKey, keyStore } from '../src/stores/key';
import { scoresStore } from '../src/stores/scores';
import { VIEW_UPDATED, isGetCsv, isGetView } from '../src/messaging';
import type { CsvPayload, ViewPayload } from '../src/messaging';

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
  async main(ctx) {
    if (!isWatchedRoute(window.location.pathname)) return;

    // A reload restores this browser session's judgments so the grid
    // repaints without paying again. A missing or unreadable cache scores
    // the screen fresh.
    const stored = await scoresStore.getValue().catch(() => null);
    const session = new MarketplaceSession(createOpenRouterGateway(), stored);
    // Painted badges by item id, with the accessible name they were painted
    // for. A remounted tile repaints from memory only when its label is
    // unchanged; a changed label rejoins the wave so the session can tell
    // a cache hit from a changed price.
    const badges = new Map<string, { badge: Badge; name: string }>();
    // Attempted but unpainted ids (failed call or omitted answers). They stay
    // out of later automatic waves: a failed chunk never retries by itself.
    // #6 Rescore will clear this set on explicit shopper request.
    const failed = new Set<string>();
    let running = false;
    let queued: TileSnapshot[] = [];
    // Bumped on every brief edit so a wave in flight cannot paint stale
    // badges over the cleared screen.
    let briefEpoch = 0;
    let lastBrief = briefHashFor(await briefStore.getValue());

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
      if (isGetCsv(message)) {
        return Promise.resolve({ csv: session.exportCsv() } satisfies CsvPayload);
      }
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
        const name = accessibleName(anchor);
        const known = badges.get(id);
        if (known !== undefined && known.name === name) {
          // Remounted tile, unchanged label: repaint from memory, never resend.
          paintBadge(anchor, known.badge);
          continue;
        }
        // A changed label may mean a changed price: forget the stored badge
        // and let the session decide cache hit vs rescore.
        badges.delete(id);
        snapshots.push({ href: anchor.href, name });
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
          const waveBriefEpoch = briefEpoch;
          const result = await session.judgeWave(brief, fresh, await hasKey());
          // A brief edit cleared the screen mid-wave: drop the stale paint.
          // The fresh wave already queued behind this one does the rescore.
          if (waveBriefEpoch !== briefEpoch) continue;
          // First snapshot wins per item id, mirroring the session's parse.
          const names = new Map<string, string>();
          for (const snapshot of fresh) {
            const id = itemId(snapshot.href) as string;
            if (!names.has(id)) names.set(id, snapshot.name);
          }
          for (const id of result.unpainted) failed.add(id);
          for (const badge of result.badges) {
            // Every badge answers a waved snapshot, so the name is always
            // known; the fallback only forces a re-wave on remount.
            badges.set(badge.id, { badge, name: names.get(badge.id) ?? '' });
            paintBadges(badge);
          }
          pushView({ panel: result.panel, brief });
          await scoresStore.setValue(session.snapshot()).catch(() => {});
        }
      } finally {
        running = false;
      }
    }

    async function refreshAfterStoreChange(brief: BriefState): Promise<void> {
      // A changed brief drops every painted badge and rescores the screen
      // as a fresh wave; the session clears its stored judgments for the
      // same brief. A new key or a first query only unlocks unpainted tiles.
      const identity = briefHashFor(brief);
      if (identity !== lastBrief) {
        lastBrief = identity;
        briefEpoch += 1;
        clearBadges();
        failed.clear();
      }
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

    // Drops every painted badge for a brief-edit rescore: the badge and
    // tint elements leave the DOM and the tiles become wave candidates again.
    function clearBadges(): void {
      for (const anchor of tileAnchors()) {
        if (anchor.dataset['dealHunterBadge'] === undefined) continue;
        clearBadge(anchor);
      }
      badges.clear();
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


