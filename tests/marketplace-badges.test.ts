import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearBadge, paintBadge } from '../src/dom/marketplace-badges';
import type { Badge } from '../src/session/marketplace';

// Minimal fake DOM: just the surface paintBadge/clearBadge touch
// (createElement, dataset, style, appendChild, querySelector(All) with the
// tag and `:scope > tag[data-attr]` selectors the code actually uses,
// animate, getComputedStyle, matchMedia). No jsdom dependency.
interface FakeElement {
  tag: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  attributes: Record<string, string>;
  textContent: string;
  children: FakeElement[];
  parent: FakeElement | null;
  parentElement: FakeElement | null;
  rect: { width: number; height: number };
  animateCalls: { keyframes: unknown; options: unknown }[];
}

function link(parent: FakeElement, child: FakeElement): void {
  child.parent = parent;
  child.parentElement = parent;
  parent.children.push(child);
}

function descendantsOf(root: FakeElement): FakeElement[] {
  const found: FakeElement[] = [];
  const walk = (element: FakeElement): void => {
    for (const child of element.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function toDatasetKey(attr: string): string {
  return attr
    .split('-')
    .map((part, index) =>
      index === 0 ? part : part[0]!.toUpperCase() + part.slice(1),
    )
    .join('');
}

function querySelectorAll(
  root: FakeElement,
  selector: string,
): FakeElement[] {
  const found: FakeElement[] = [];
  for (const part of selector.split(',')) {
    const trimmed = part.trim();
    const scoped = /^:scope > (\w+)\[data-([\w-]+)\]$/.exec(trimmed);
    const deep = /^(\w+)\[data-([\w-]+)\]$/.exec(trimmed);
    const tagOnly = /^(\w+)$/.exec(trimmed);
    const parsed = scoped ?? deep ?? tagOnly;
    if (parsed === null) throw new Error(`unsupported selector: ${trimmed}`);
    const tag = parsed[1] as string;
    const attr = parsed[2] as string | undefined;
    const candidates = scoped !== null ? root.children : descendantsOf(root);
    for (const child of candidates) {
      if (child.tag !== tag) continue;
      if (attr !== undefined && child.dataset[toDatasetKey(attr)] === undefined) {
        continue;
      }
      found.push(child);
    }
  }
  return found;
}

function querySelector(
  root: FakeElement,
  selector: string,
): FakeElement | null {
  // The code under test only uses tag-name selectors here.
  for (const candidate of descendantsOf(root)) {
    if (candidate.tag === selector) return candidate;
  }
  return null;
}

function makeElement(tag: string): FakeElement {
  const element: FakeElement = {
    tag,
    dataset: {},
    style: {},
    attributes: {},
    textContent: '',
    children: [],
    parent: null,
    parentElement: null,
    rect: { width: 0, height: 0 },
    animateCalls: [],
  };
  const live = element as unknown as Record<string, unknown>;
  live['appendChild'] = (child: FakeElement): FakeElement => {
    link(element, child);
    return child;
  };
  live['remove'] = (): void => {
    if (element.parent === null) return;
    element.parent.children = element.parent.children.filter(
      (child) => child !== element,
    );
    element.parent = null;
    element.parentElement = null;
  };
  live['setAttribute'] = (name: string, value: string): void => {
    element.attributes[name] = value;
  };
  live['animate'] = (keyframes: unknown, options?: unknown): undefined => {
    element.animateCalls.push({ keyframes, options });
    return undefined;
  };
  live['getBoundingClientRect'] = (): { width: number; height: number } =>
    element.rect;
  live['querySelector'] = (selector: string): FakeElement | null =>
    querySelector(element, selector);
  live['querySelectorAll'] = (selector: string): FakeElement[] =>
    querySelectorAll(element, selector);
  return element;
}

function asAnchor(element: FakeElement): HTMLAnchorElement {
  return element as unknown as HTMLAnchorElement;
}

// A tile shaped like the real grid markup: nested divs down to the photo.
function photoTile(): { anchor: FakeElement; imageBox: FakeElement } {
  const anchor = makeElement('a');
  const outer = makeElement('div');
  const middle = makeElement('div');
  const imageBox = makeElement('div');
  const image = makeElement('img');
  image.rect = { width: 300, height: 300 };
  link(anchor, outer);
  link(outer, middle);
  link(middle, imageBox);
  link(imageBox, image);
  return { anchor, imageBox };
}

let reduceMotion = false;

beforeEach(() => {
  reduceMotion = false;
  const fakeDocument = {
    createElement: (tag: string): unknown => makeElement(tag),
  };
  const fakeWindow = {
    getComputedStyle: (): { position: string } => ({ position: 'static' }),
    matchMedia: (): { matches: boolean } => ({ matches: reduceMotion }),
  };
  (globalThis as Record<string, unknown>)['document'] = fakeDocument;
  (globalThis as Record<string, unknown>)['window'] = fakeWindow;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['document'];
  delete (globalThis as Record<string, unknown>)['window'];
});

function tintsOf(anchor: FakeElement): FakeElement[] {
  return descendantsOf(anchor).filter(
    (child) => child.dataset['dealHunterTintEl'] !== undefined,
  );
}

function pillsOf(anchor: FakeElement): FakeElement[] {
  return anchor.children.filter(
    (child) => child.dataset['dealHunterBadgeEl'] !== undefined,
  );
}

describe('marketplace badges', () => {
  it('paints the badge pill for every tone', () => {
    const badges: Badge[] = [
      { id: '1', text: 'MATCH 2.6', tone: 'match' },
      { id: '2', text: 'SKIP PRICE', tone: 'skip' },
      { id: '3', text: 'REVIEW 1.4', tone: 'review' },
    ];
    for (const badge of badges) {
      const anchor = makeElement('a');
      paintBadge(asAnchor(anchor), badge);
      const pills = pillsOf(anchor);
      expect(pills).toHaveLength(1);
      expect(pills[0]!.textContent).toBe(badge.text);
    }
  });

  it.each(['MATCH 2.0', 'MATCH 2.2', 'MATCH 2.6', 'MATCH 3.0'])(
    'paints the green wash for %s, not just one score',
    (text) => {
      const anchor = makeElement('a');
      paintBadge(asAnchor(anchor), { id: '7', text, tone: 'match' });
      const tints = tintsOf(anchor);
      expect(tints).toHaveLength(1);
      const tint = tints[0]!;
      // Covers the tile, sits above page layers but below the pill.
      expect(tint.style['position']).toBe('absolute');
      expect(tint.style['inset']).toBe('0');
      expect(Number(tint.style['zIndex'])).toBeLessThan(
        Number(pillsOf(anchor)[0]!.style['zIndex']),
      );
      // Clicks pass through; the settled wash and ring stay on the tile.
      expect(tint.style['pointerEvents']).toBe('none');
      expect(tint.style['background']).toMatch(/rgba\(19, 115, 51, [\d.]+\)/);
      expect(tint.style['boxShadow']).toContain('inset');
      expect(tint.attributes['aria-hidden']).toBe('true');
    },
  );

  it('hosts the wash on the image box when the tile has a photo', () => {
    const { anchor, imageBox } = photoTile();
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    const tints = tintsOf(anchor);
    expect(tints).toHaveLength(1);
    // The green covers the picture, not the price/title text; the pill
    // stays a direct child of the tile link.
    expect(tints[0]!.parentElement).toBe(imageBox);
    expect(imageBox.style['position']).toBe('relative');
    expect(pillsOf(anchor)).toHaveLength(1);
  });

  it('washes the largest visible photo, ignoring hidden images', () => {
    const { anchor, imageBox } = photoTile();
    // A zero-area prefetch/decoy image ahead of the real photo.
    const decoyBox = makeElement('div');
    const decoy = makeElement('img');
    link(decoyBox, decoy);
    anchor.children.unshift(decoyBox);
    decoyBox.parent = anchor;
    decoyBox.parentElement = anchor;
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    const tints = tintsOf(anchor);
    expect(tints).toHaveLength(1);
    expect(tints[0]!.parentElement).toBe(imageBox);
  });

  it('falls back to the whole tile when no image is in the DOM yet', () => {
    const anchor = makeElement('a');
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    const tints = tintsOf(anchor);
    expect(tints).toHaveLength(1);
    expect(tints[0]!.parentElement).toBe(anchor);
  });

  it('falls back to the whole tile when every image is hidden', () => {
    const { anchor } = photoTile();
    for (const image of descendantsOf(anchor).filter(
      (child) => child.tag === 'img',
    )) {
      image.rect = { width: 0, height: 0 };
    }
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    const tints = tintsOf(anchor);
    expect(tints).toHaveLength(1);
    expect(tints[0]!.parentElement).toBe(anchor);
  });

  it('paints no wash for SKIP or REVIEW tones', () => {
    const badges: Badge[] = [
      { id: '1', text: 'SKIP PRICE', tone: 'skip' },
      { id: '2', text: 'REVIEW 1.4', tone: 'review' },
    ];
    for (const badge of badges) {
      const { anchor } = photoTile();
      paintBadge(asAnchor(anchor), badge);
      expect(tintsOf(anchor)).toHaveLength(0);
      expect(pillsOf(anchor)).toHaveLength(1);
    }
  });

  it('fades the wash in, settling on the persistent tint', () => {
    const { anchor } = photoTile();
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    const tint = tintsOf(anchor)[0]!;
    expect(tint.animateCalls).toHaveLength(1);
    const call = tint.animateCalls[0]!;
    expect(call.options).toMatchObject({ easing: 'ease-out' });
    const keyframes = call.keyframes as Record<string, unknown>[];
    expect(keyframes[0]!['opacity']).toBe(0);
    expect(keyframes[keyframes.length - 1]!['opacity']).toBe(1);
    expect(keyframes[keyframes.length - 1]!['background']).toBe(
      tint.style['background'],
    );
  });

  it('keeps the wash without animation under reduced motion', () => {
    reduceMotion = true;
    const { anchor } = photoTile();
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    expect(tintsOf(anchor)).toHaveLength(1);
    expect(pillsOf(anchor)).toHaveLength(1);
    for (const child of descendantsOf(anchor)) {
      expect(child.animateCalls).toHaveLength(0);
    }
  });

  it('clears the pill and the wash together', () => {
    const anchor = makeElement('a');
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    expect(anchor.children).toHaveLength(2);
    clearBadge(asAnchor(anchor));
    expect(anchor.children).toHaveLength(0);
    expect(anchor.dataset['dealHunterBadge']).toBeUndefined();
  });

  it('clears a wash nested in the image box', () => {
    const { anchor } = photoTile();
    paintBadge(asAnchor(anchor), { id: '7', text: 'MATCH 2.6', tone: 'match' });
    expect(tintsOf(anchor)).toHaveLength(1);
    clearBadge(asAnchor(anchor));
    expect(tintsOf(anchor)).toHaveLength(0);
    expect(pillsOf(anchor)).toHaveLength(0);
    expect(anchor.dataset['dealHunterBadge']).toBeUndefined();
  });
});
