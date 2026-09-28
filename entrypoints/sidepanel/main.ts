import { browser } from 'wxt/browser';
import type { PanelModel, Verdict } from '../../src/session/marketplace';
import { briefStore } from '../../src/stores/brief';
import { GET_VIEW, isViewUpdated } from '../../src/messaging';
import type { ViewPayload } from '../../src/messaging';

// Side panel: brief editor plus a read-only ranking of the tab's judgments.
// It renders what the content script's session reports. The key never
// appears here.
const queryInput = document.querySelector<HTMLInputElement>('#query')!;
const notice = document.querySelector('#notice')!;
const entriesList = document.querySelector('#entries')!;
const emptyState = document.querySelector('#empty')!;
const stats: Record<string, HTMLElement> = {
  scanned: document.querySelector('#stat-scanned')!,
  kept: document.querySelector('#stat-kept')!,
  skipped: document.querySelector('#stat-skipped')!,
  review: document.querySelector('#stat-review')!,
  ms: document.querySelector('#stat-ms')!,
  cost: document.querySelector('#stat-cost')!,
};

let tabId: number | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

queryInput.addEventListener('input', () => {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void briefStore.setValue({ query: queryInput.value });
  }, 300);
});

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isViewUpdated(message)) return;
  if (sender.tab?.id === undefined || sender.tab.id !== tabId) return;
  applyView(message.view as ViewPayload);
});

browser.tabs.onActivated.addListener((activeInfo) => {
  void refresh(activeInfo.tabId);
});

void refreshCurrentTab();

async function refreshCurrentTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  await refresh(tab?.id);
}

async function refresh(id: number | undefined): Promise<void> {
  tabId = id ?? null;
  if (tabId === null) {
    applyNoTab();
    return;
  }
  let view: ViewPayload;
  try {
    view = (await browser.tabs.sendMessage(tabId, { type: GET_VIEW })) as ViewPayload;
  } catch {
    applyNoTab();
    return;
  }
  if (typeof view?.panel !== 'object' || typeof view?.brief !== 'object') {
    applyNoTab();
    return;
  }
  applyView(view);
}

const EMPTY_PANEL: PanelModel = {
  status: 'ready',
  notice: null,
  entries: [],
  scanned: 0,
  kept: 0,
  skipped: 0,
  review: 0,
  lastMs: null,
  totalCost: 0,
  error: null,
};

function applyNoTab(): void {
  notice.classList.remove('error');
  notice.textContent = 'Open a Marketplace grid to start judging.';
  // Never show another tab's judgments here.
  renderStats(EMPTY_PANEL);
  renderEntries(EMPTY_PANEL);
  if (document.activeElement !== queryInput) {
    void briefStore.getValue().then((brief) => {
      queryInput.value = brief.query;
    });
  }
}

function applyView(view: ViewPayload): void {
  if (document.activeElement !== queryInput) {
    queryInput.value = view.brief.query;
  }
  renderNotice(view.panel);
  renderStats(view.panel);
  renderEntries(view.panel);
}

function renderNotice(panel: PanelModel): void {
  notice.classList.toggle('error', panel.error !== null);
  if (panel.error !== null) {
    notice.textContent = panel.error;
  } else {
    notice.textContent = panel.notice ?? '';
  }
}

function renderStats(panel: PanelModel): void {
  stats['scanned']!.textContent = `${panel.scanned}`;
  stats['kept']!.textContent = `${panel.kept}`;
  stats['skipped']!.textContent = `${panel.skipped}`;
  stats['review']!.textContent = `${panel.review}`;
  stats['ms']!.textContent = panel.lastMs === null ? '—' : `${panel.lastMs} ms`;
  stats['cost']!.textContent = `$${panel.totalCost.toFixed(4)}`;
}

function renderEntries(panel: PanelModel): void {
  entriesList.replaceChildren();
  emptyState.textContent =
    panel.entries.length === 0 ? 'No judgments yet.' : '';
  for (const entry of panel.entries) {
    const item = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = `chip ${chipTone(entry.verdict)}`;
    chip.textContent = entry.verdict;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title;
    title.title = entry.title;
    const fit = document.createElement('span');
    fit.className = 'fit';
    fit.textContent = entry.fit.toFixed(1);
    item.append(chip, title, fit);
    entriesList.append(item);
  }
}

function chipTone(verdict: Verdict): string {
  return verdict.toLowerCase();
}
