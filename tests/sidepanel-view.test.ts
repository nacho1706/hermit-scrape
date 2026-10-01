import { describe, expect, it } from 'vitest';
import {
  invalidationText,
  maxPriceHint,
  parseMaxPriceInput,
  statusText,
} from '../src/sidepanel/view';

// Pure view helpers for the side panel: max-price validation never coerces
// garbage to "no cap", the status line names save/tab/data state, and the
// brief-change banner names what the new brief replaced.
describe('parseMaxPriceInput', () => {
  it('reads empty as no cap', () => {
    expect(parseMaxPriceInput('')).toEqual({ valid: true, value: null });
    expect(parseMaxPriceInput('   ')).toEqual({ valid: true, value: null });
  });

  it('reads Argentine grouped digits as one integer', () => {
    expect(parseMaxPriceInput('250.000')).toEqual({ valid: true, value: 250000 });
    expect(parseMaxPriceInput('1 000')).toEqual({ valid: true, value: 1000 });
  });

  it('reads a trailing short separator as decimals', () => {
    expect(parseMaxPriceInput('1.234,56')).toEqual({ valid: true, value: 1234.56 });
  });

  it('rejects garbage instead of coercing to no cap', () => {
    expect(parseMaxPriceInput('12x')).toEqual({ valid: false });
    expect(parseMaxPriceInput('abc')).toEqual({ valid: false });
    expect(parseMaxPriceInput('-5')).toEqual({ valid: false });
    expect(parseMaxPriceInput('$')).toEqual({ valid: false });
  });

  it('reads listing-style prices the way tiles print them', () => {
    expect(parseMaxPriceInput('$250')).toEqual({ valid: true, value: 250 });
    expect(parseMaxPriceInput('USD 200')).toEqual({ valid: true, value: 200 });
    expect(parseMaxPriceInput('250k')).toEqual({ valid: true, value: 250000 });
  });
});

describe('maxPriceHint', () => {
  it('echoes the parsed cap with its currency', () => {
    expect(maxPriceHint({ valid: true, value: 250000 }, null, 'ARS')).toBe(
      'Cap: 250.000 ARS',
    );
  });

  it('stays silent when no cap is set', () => {
    expect(maxPriceHint({ valid: true, value: null }, null, 'ARS')).toBe('');
  });

  it('names the kept cap when input is unreadable', () => {
    expect(maxPriceHint({ valid: false }, 100000, 'ARS')).toBe(
      "Couldn't read that price — keeping 100.000 ARS.",
    );
  });

  it('names no cap when input is unreadable and none is kept', () => {
    expect(maxPriceHint({ valid: false }, null, 'USD')).toBe(
      "Couldn't read that price — no cap set.",
    );
  });
});

describe('statusText', () => {
  it('names saving, the bound tab, and the judgment count', () => {
    expect(
      statusText({ dirty: true, tabBound: true, judgments: 12, hasError: false }),
    ).toBe('Saving… · Tab: Marketplace grid · 12 judgments');
  });

  it('uses the singular for one judgment', () => {
    expect(
      statusText({ dirty: false, tabBound: true, judgments: 1, hasError: false }),
    ).toBe('Saved · Tab: Marketplace grid · 1 judgment');
  });

  it('names the empty and unbound states', () => {
    expect(
      statusText({ dirty: false, tabBound: true, judgments: 0, hasError: false }),
    ).toBe('Saved · Tab: Marketplace grid · No judgments yet');
    expect(
      statusText({ dirty: false, tabBound: false, judgments: 0, hasError: false }),
    ).toBe('Saved · Tab: — · —');
  });

  it('names errors over counts', () => {
    expect(
      statusText({ dirty: false, tabBound: true, judgments: 3, hasError: true }),
    ).toBe('Saved · Tab: Marketplace grid · Error');
  });
});

describe('invalidationText', () => {
  it('names the replaced count when fresh judgments arrive', () => {
    expect(invalidationText(4, 9)).toBe(
      'Brief changed — 4 previous judgments replaced with 9 fresh.',
    );
    expect(invalidationText(1, 1)).toBe(
      'Brief changed — 1 previous judgment replaced with 1 fresh.',
    );
  });

  it('says re-judging when nothing fresh has arrived', () => {
    expect(invalidationText(4, 0)).toBe(
      'Brief changed — 4 previous judgments discarded; re-judging…',
    );
  });
});
