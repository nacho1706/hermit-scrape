import { browser } from 'wxt/browser';
import type { PanelModel, Verdict } from '../../src/session/marketplace';
import { briefHashFor, parsePlacesInput } from '../../src/session/marketplace';
import { briefStore } from '../../src/stores/brief';
import type { BriefState } from '../../src/stores/brief';
import { GET_CSV, GET_VIEW, isCsvPayload, isViewUpdated } from '../../src/messaging';
import type { ViewPayload } from '../../src/messaging';
import {
  invalidationText,
  maxPriceHint,
  parseMaxPriceInput,
  statusText,
} from '../../src/sidepanel/view';

// Side panel: brief editor plus a read-only ranking of the tab's judgments.
// It renders what the content script's session reports. The key never
// appears here.
//
// Three states stay visible at all times: the save lifecycle (Saving…/
// Saved), the bound tab, and what the current data holds. A brief edit
// never silently swaps the list: the previous render is kept and named.
const queryInput = document.querySelector<HTMLInputElement>('#query')!;
const maxPriceInput = document.querySelector<HTMLInputElement>('#max-price')!;
const maxPriceHintLine = document.querySelector('#max-price-hint')!;
const maxPriceErrorLine = document.querySelector('#max-price-error')!;
const currencySelect = document.querySelector<HTMLSelectElement>('#currency')!;
const placesInput = document.querySelector<HTMLInputElement>('#places')!;
const noteInput = document.querySelector<HTMLTextAreaElement>('#note')!;
const notice = document.querySelector('#notice')!;
const statusline = document.querySelector('#statusline')!;
// The banner is not a live region: wave updates rewrite its counts and a
// live region would chatter. It persists inline, next to the list it names.
const banner = document.querySelector<HTMLElement>('#brief-banner')!;
const bannerText = document.querySelector('#brief-banner-text')!;
const showPreviousButton = document.querySelector<HTMLButtonElement>('#show-previous')!;
const dismissBannerButton = document.querySelector<HTMLButtonElement>('#dismiss-banner')!;
const entriesList = document.querySelector('#entries')!;
const emptyState = document.querySelector('#empty')!;
const exportButton = document.querySelector<HTMLButtonElement>('#export-csv')!;
const stats: Record<string, HTMLElement> = {
  scanned: document.querySelector('#stat-scanned')!,
  kept: document.querySelector('#stat-kept')!,
  skipped: document.querySelector('#stat-skipped')!,
  review: document.querySelector('#stat-review')!,
  ms: document.querySelector('#stat-ms')!,
  cost: document.querySelector('#stat-cost')!,
};

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

let tabId: number | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// The brief is dirty while a queued save has not finished. Sequence numbers
// keep overlapping saves honest: only the latest completion clears dirty.
let saveSeq = 0;
let savedSeq = 0;
let tabBound = false;
let currentPanel: PanelModel = EMPTY_PANEL;
let renderedBriefHash: string | null = null;
// The last render under the previous brief, kept for the banner's "Show
// previous" toggle. Dropped on tab switch, dismiss, or the next brief edit.
let stalePanel: PanelModel | null = null;
let showingStale = false;
let savedMaxPrice: number | null = null;
let savedCurrency: 'ARS' | 'USD' = 'ARS';

function queueSave(patch: Partial<BriefState>): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveSeq += 1;
  renderStatus();
  const seq = saveSeq;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void briefStore.getValue().then((current) => {
      void briefStore.setValue({ ...current, ...patch }).then(() => {
        if (seq > savedSeq) savedSeq = seq;
        renderStatus();
      });
    });
  }, 300);
}

queryInput.addEventListener('input', () => {
  queueSave({ query: queryInput.value });
});

maxPriceInput.addEventListener('input', () => {
  updateMaxPriceHint();
  const parsed = parseMaxPriceInput(maxPriceInput.value);
  // Unreadable input is never saved: null means "no cap", so saving it
  // would widen the hunt instead of flagging the typo.
  if (!parsed.valid) return;
  queueSave({ maxPrice: parsed.value });
});

function updateMaxPriceHint(): void {
  const parsed = parseMaxPriceInput(maxPriceInput.value);
  // The echo and the error live in separate lines: the error is an alert
  // (announced once when it appears) while the echo stays silent so
  // per-keystroke parse confirmations never chatter.
  if (!parsed.valid) {
    maxPriceInput.setAttribute('aria-invalid', 'true');
    maxPriceHintLine.textContent = '';
    maxPriceErrorLine.textContent = maxPriceHint(parsed, savedMaxPrice, savedCurrency);
  } else {
    maxPriceInput.removeAttribute('aria-invalid');
    maxPriceErrorLine.textContent = '';
    maxPriceHintLine.textContent = maxPriceHint(parsed, savedMaxPrice, savedCurrency);
  }
}

currencySelect.addEventListener('change', () => {
  queueSave({ currency: asCurrency(currencySelect.value) });
  updateMaxPriceHint();
});

function asCurrency(value: string): 'ARS' | 'USD' {
  return value === 'USD' ? 'USD' : 'ARS';
}

placesInput.addEventListener('input', () => {
  queueSave({ places: parsePlacesInput(placesInput.value) });
});

noteInput.addEventListener('input', () => {
  queueSave({ note: noteInput.value });
});

exportButton.addEventListener('click', () => {
  void downloadCsv();
});

showPreviousButton.addEventListener('click', () => {
  if (stalePanel === null) return;
  showingStale = !showingStale;
  showPreviousButton.setAttribute('aria-pressed', showingStale ? 'true' : 'false');
  if (showingStale) {
    const count = stalePanel.entries.length;
    bannerText.textContent =
      `Showing previous brief's ${count} judgment${count === 1 ? '' : 's'} (stale).`;
    showPreviousButton.textContent = 'Show current';
    renderNotice(stalePanel);
    renderStats(stalePanel);
  } else {
    showPreviousButton.textContent = 'Show previous';
    renderBannerCounts();
    renderNotice(currentPanel);
    renderStats(currentPanel);
  }
  // Export always reads the live session, never the stale render.
  renderEntries(showingStale && stalePanel !== null ? stalePanel : currentPanel, currentPanel);
});

dismissBannerButton.addEventListener('click', () => {
  clearStale();
  renderNotice(currentPanel);
  renderStats(currentPanel);
  renderEntries(currentPanel, currentPanel);
});

async function downloadCsv(): Promise<void> {
  if (tabId === null) return;
  let csv: string;
  try {
    const reply: unknown = await browser.tabs.sendMessage(tabId, { type: GET_CSV });
    if (!isCsvPayload(reply)) return;
    csv = reply.csv;
  } catch {
    return;
  }
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'deal-hunter-session.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

renderStatus();
void refreshCurrentTab();

async function refreshCurrentTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  await refresh(tab?.id);
}

async function refresh(id: number | undefined): Promise<void> {
  tabId = id ?? null;
  // A new tab means a new session: the invalidation baseline restarts so a
  // tab switch never reads as a brief change.
  clearStale();
  renderedBriefHash = null;
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

function applyNoTab(): void {
  tabBound = false;
  currentPanel = EMPTY_PANEL;
  notice.classList.remove('error');
  notice.textContent = 'Open a Marketplace grid to start judging.';
  exportButton.disabled = true;
  // Never show another tab's judgments here.
  renderStats(EMPTY_PANEL);
  renderEntries(EMPTY_PANEL, EMPTY_PANEL);
  renderStatus();
  void briefStore.getValue().then((brief) => {
    applyBrief(brief);
  });
}

function applyView(view: ViewPayload): void {
  applyBrief(view.brief);
  tabBound = true;
  const hash = briefHashFor(view.brief);
  if (renderedBriefHash !== null && hash !== renderedBriefHash) {
    // The brief changed underneath the rendered list. Keep the previous
    // render and name the swap; the content script rescores automatically.
    const previousCount = currentPanel.entries.length;
    if (previousCount > 0) {
      stalePanel = currentPanel;
      showingStale = false;
      showPreviousButton.textContent = 'Show previous';
      showPreviousButton.setAttribute('aria-pressed', 'false');
      currentPanel = view.panel;
      renderBannerCounts();
      banner.hidden = false;
    } else {
      clearStale();
      currentPanel = view.panel;
    }
  } else {
    currentPanel = view.panel;
    if (stalePanel !== null) renderBannerCounts();
  }
  renderedBriefHash = hash;
  if (showingStale && stalePanel !== null) {
    renderNotice(stalePanel);
    renderStats(stalePanel);
    renderEntries(stalePanel, currentPanel);
  } else {
    renderNotice(currentPanel);
    renderStats(currentPanel);
    renderEntries(currentPanel, currentPanel);
  }
  renderStatus();
}

function renderBannerCounts(): void {
  if (stalePanel === null) return;
  bannerText.textContent = invalidationText(
    stalePanel.entries.length,
    currentPanel.entries.length,
  );
}

function clearStale(): void {
  stalePanel = null;
  showingStale = false;
  showPreviousButton.setAttribute('aria-pressed', 'false');
  banner.hidden = true;
  bannerText.textContent = '';
}

function renderStatus(): void {
  statusline.textContent = statusText({
    dirty: saveSeq !== savedSeq,
    tabBound,
    judgments: currentPanel.entries.length,
    hasError: currentPanel.error !== null,
  });
}

function applyBrief(brief: BriefState): void {
  savedMaxPrice = brief.maxPrice ?? null;
  savedCurrency = asCurrency(brief.currency ?? 'ARS');
  setUnlessFocused(queryInput, brief.query ?? '');
  setUnlessFocused(maxPriceInput, formatMaxPrice(brief.maxPrice ?? null));
  setUnlessFocused(currencySelect, asCurrency(brief.currency ?? 'ARS'));
  setUnlessFocused(placesInput, (brief.places ?? []).join('; '));
  setUnlessFocused(noteInput, brief.note ?? '');
  // A pushed brief overwrites the visible field, so its hint belongs to the
  // saved value (empty). While the field holds focus the hint tracks the
  // keystrokes instead.
  if (document.activeElement !== maxPriceInput) {
    maxPriceInput.removeAttribute('aria-invalid');
    maxPriceHintLine.textContent = '';
    maxPriceErrorLine.textContent = '';
  }
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

function renderEntries(displayed: PanelModel, forExport: PanelModel): void {
  entriesList.replaceChildren();
  emptyState.textContent =
    displayed.entries.length === 0 ? 'No judgments yet.' : '';
  // CSV covers every kept judgment, so export needs a tab with judgments.
  exportButton.disabled = tabId === null || forExport.entries.length === 0;
  for (const entry of displayed.entries) {
    const item = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = `chip ${chipTone(entry.verdict)}`;
    chip.textContent = entry.verdict;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title;
    title.title = entry.title;
    const fit = document.createElement('span');
    // A local SKIP shows its reason and no model score.
    fit.className = entry.fit === null ? 'fit reason' : 'fit';
    fit.textContent = entry.fit === null ? (entry.reason ?? '') : entry.fit.toFixed(1);
    item.append(chip, title, fit);
    entriesList.append(item);
  }
}

function chipTone(verdict: Verdict): string {
  return verdict.toLowerCase();
}
