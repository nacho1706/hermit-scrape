import { parseMaxPriceInput as parseMarketplaceMaxPrice } from '../session/marketplace';

// Pure view helpers for the side panel. DOM-free so the panel's wording and
// validation stay unit-testable without the extension runtime.

// A max-price keystroke is either a cap (null when the field is empty) or
// unreadable. Unreadable input is never saved: it must not coerce to null,
// because null means "no cap" and would widen the hunt. Parsing itself is
// the marketplace's, so pasted listing prices read the way tiles print them.
export type MaxPriceInput = { valid: true; value: number | null } | { valid: false };

export function parseMaxPriceInput(value: string): MaxPriceInput {
  if (value.trim() === '') return { valid: true, value: null };
  const amount = parseMarketplaceMaxPrice(value);
  return amount === null ? { valid: false } : { valid: true, value: amount };
}

const capFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });

export function formatCap(amount: number): string {
  return capFormat.format(amount);
}

// The line under the max-price field: an echo of the parsed cap while the
// input is valid, or the kept cap when the input cannot be read.
export function maxPriceHint(
  input: MaxPriceInput,
  keptCap: number | null,
  currency: string,
): string {
  if (!input.valid) {
    return keptCap === null
      ? "Couldn't read that price — no cap set."
      : `Couldn't read that price — keeping ${formatCap(keptCap)} ${currency}.`;
  }
  if (input.value === null) return '';
  return `Cap: ${formatCap(input.value)} ${currency}`;
}

export interface StatusState {
  dirty: boolean;
  tabBound: boolean;
  judgments: number;
  hasError: boolean;
}

// The one-line status strip under the brief editor: save state, bound tab,
// and what the current data holds. It never guesses "judging": the panel
// cannot tell a preview view from a settled one, so it reports only states
// it can verify.
export function statusText(state: StatusState): string {
  const save = state.dirty ? 'Saving…' : 'Saved';
  const tab = state.tabBound ? 'Tab: Marketplace grid' : 'Tab: —';
  let data: string;
  if (!state.tabBound) {
    data = '—';
  } else if (state.hasError) {
    data = 'Error';
  } else if (state.judgments === 0) {
    data = 'No judgments yet';
  } else if (state.judgments === 1) {
    data = '1 judgment';
  } else {
    data = `${state.judgments} judgments`;
  }
  return `${save} · ${tab} · ${data}`;
}

// The banner shown when a view arrives under a new brief while previous
// judgments are on screen: it names what the new brief replaced.
export function invalidationText(previousCount: number, currentCount: number): string {
  const previous =
    previousCount === 1 ? '1 previous judgment' : `${previousCount} previous judgments`;
  if (currentCount === 0) {
    return `Brief changed — ${previous} discarded; re-judging…`;
  }
  return `Brief changed — ${previous} replaced with ${currentCount} fresh.`;
}
