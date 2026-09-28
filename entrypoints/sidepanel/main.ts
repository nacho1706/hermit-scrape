import { browser } from 'wxt/browser';
import type { PanelModel, Verdict } from '../../src/session/marketplace';
import { parseAmount } from '../../src/session/marketplace';
import { briefStore } from '../../src/stores/brief';
import type { BriefState } from '../../src/stores/brief';
import { GET_VIEW, isViewUpdated } from '../../src/messaging';
import type { ViewPayload } from '../../src/messaging';

// Side panel: brief editor plus a read-only ranking of the tab's judgments.
// It renders what the content script's session reports. The key never
// appears here.
const queryInput = document.querySelector<HTMLInputElement>('#query')!;
const maxPriceInput = document.querySelector<HTMLInputElement>('#max-price')!;
const currencySelect = document.querySelector<HTMLSelectElement>('#currency')!;
const placesInput = document.querySelector<HTMLInputElement>('#places')!;
const noteInput = document.querySelector<HTMLTextAreaElement>('#note')!;
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

function queueSave(patch: Partial<BriefState>): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void briefStore.getValue().then((current) => {
      void briefStore.setValue({ ...current, ...patch });
    });
  }, 300);
}

queryInput.addEventListener('input', () => {
  queueSave({ query: queryInput.value });
});

maxPriceInput.addEventListener('input', () => {
  queueSave({ maxPrice: readMaxPrice(maxPriceInput.value) });
});

currencySelect.addEventListener('change', () => {
  queueSave({ currency: asCurrency(currencySelect.value) });
});

function asCurrency(value: string): 'ARS' | 'USD' {
  return value === 'USD' ? 'USD' : 'ARS';
}

placesInput.addEventListener('input', () => {
  queueSave({ places: readPlaces(placesInput.value) });
});

noteInput.addEventListener('input', () => {
  queueSave({ note: noteInput.value });
});

function readMaxPrice(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!/^\d[\d.,\s]*$/.test(trimmed)) return null;
  const amount = parseAmount(trimmed);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function readPlaces(value: string): string[] {
  return value
    .split(',')
    .map((place) => place.trim())
    .filter((place) => place !== '');
}

function formatMaxPrice(maxPrice: number | null): string {
  return maxPrice === null ? '' : `${maxPrice}`;
}

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
  void briefStore.getValue().then((brief) => {
    applyBrief(brief);
  });
}

function applyView(view: ViewPayload): void {
  applyBrief(view.brief);
  renderNotice(view.panel);
  renderStats(view.panel);
  renderEntries(view.panel);
}

function applyBrief(brief: BriefState): void {
  setUnlessFocused(queryInput, brief.query ?? '');
  setUnlessFocused(maxPriceInput, formatMaxPrice(brief.maxPrice ?? null));
  setUnlessFocused(currencySelect, asCurrency(brief.currency ?? 'ARS'));
  setUnlessFocused(placesInput, (brief.places ?? []).join(', '));
  setUnlessFocused(noteInput, brief.note ?? '');
}

function setUnlessFocused(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  if (document.activeElement !== element) {
    element.value = value;
  }
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
    // A local SKIP shows its reason and no model score.
    fit.textContent = entry.fit === null ? (entry.reason ?? '') : entry.fit.toFixed(1);
    item.append(chip, title, fit);
    entriesList.append(item);
  }
}

function chipTone(verdict: Verdict): string {
  return verdict.toLowerCase();
}
