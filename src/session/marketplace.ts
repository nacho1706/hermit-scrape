// Behavioral core for the Deal Hunter marketplace slices (#2 through #7).
//
// The marketplace session decides verdicts. Adapters (tile reader, Jev gateway,
// grid painter, side panel, stores) surround it and are not covered by tests.
// Tests script the gateway, so nothing here touches the DOM or the network.
//
// Brief fields beyond the query are optional so older callers and stored
// briefs keep working; missing values normalize to no cap, ARS, no places,
// and an empty note. Price is null when the tile shows no number; currency
// is null alongside a missing price.

export type BriefCurrency = 'ARS' | 'USD';

export interface Brief {
  query: string;
  maxPrice?: number | null;
  currency?: BriefCurrency;
  places?: string[];
  note?: string;
}

export type LocalReason = 'price' | 'no price' | 'currency' | 'location';

export interface TileSnapshot {
  href: string;
  name: string;
  // Present only for a listing the shopper has opened.
  description?: string;
}

export interface ListingState {
  id: string;
  title: string;
  price: number | null;
  currency: string | null;
  place: string;
  // Present only on the opened-listing request for that listing.
  description?: string;
}

export interface ScoreQuestion {
  kind: 'score';
  name: string;
  instruction: string;
  levels: [string, string, string, string];
}

export interface NoulQuestion {
  kind: 'noul';
  name: string;
  instruction: string;
  trueCriterion: string;
  falseCriterion: string;
}

export type DecisionQuestion = ScoreQuestion | NoulQuestion;

export interface DecisionRequest {
  model: string;
  state: {
    query: string;
    note: string;
    listings: ListingState[];
  };
  questions: DecisionQuestion[];
}

export type AnswerValue =
  | { kind: 'score'; value: number; confidence: number }
  | { kind: 'noul'; probabilityTrue: number };

export interface GatewaySuccess {
  ok: true;
  answers: Record<string, AnswerValue>;
  ms: number;
  cost: number;
}

export interface GatewayFailure {
  ok: false;
  error: string;
  ms: number;
}

export type GatewayResult = GatewaySuccess | GatewayFailure;

export interface Gateway {
  send(request: DecisionRequest): Promise<GatewayResult>;
}

export type Verdict = 'MATCH' | 'SKIP' | 'REVIEW';

export type BadgeTone = 'match' | 'skip' | 'review';

export interface Badge {
  id: string;
  text: string;
  tone: BadgeTone;
}

export interface PanelEntry {
  id: string;
  title: string;
  verdict: Verdict;
  // Null for a local SKIP, which carries a reason and no model scores.
  fit: number | null;
  reason: LocalReason | null;
}

export type PanelStatus = 'ready' | 'need-query' | 'need-key';

export interface PanelModel {
  status: PanelStatus;
  notice: string | null;
  entries: PanelEntry[];
  scanned: number;
  kept: number;
  skipped: number;
  review: number;
  lastMs: number | null;
  totalCost: number;
  error: string | null;
}

export interface WaveResult {
  badges: Badge[];
  unpainted: string[];
  panel: PanelModel;
}

const NEED_QUERY_NOTICE = 'Type a product query to start judging.';
const NEED_KEY_NOTICE = 'Add your OpenRouter key on the options page.';

const MODEL_ID = 'jev-1.13';
const CHUNK_SIZE = 12;

const DEALBREAKER_SKIP_AT = 0.8;
const LOW_CONFIDENCE_REVIEW_BELOW = 0.45;
const FIT_MATCH_AT = 2;
const FIT_SKIP_BELOW = 1;

const FIT_INSTRUCTION =
  "Judge how well this listing matches the shopper's request. " +
  'Judge the product itself, and ignore whether the price is a bargain.';
const FIT_LEVELS: [string, string, string, string] = [
  'A different product, or a title that clearly refers to something else.',
  'Related, but the wrong model, generation, size, or a weak match.',
  'The product they asked for, and nothing in the text conflicts with the note.',
  'A clear match to the product and the note.',
];
const DEALBREAKER_INSTRUCTION =
  'Is there a concrete reason to reject this listing? ' +
  'Reject when the listing is broken, for parts, missing essential pieces, ' +
  'replica or scam wording, or a title that contradicts the request. ' +
  'A short title with no red flag is not a dealbreaker.';
const DEALBREAKER_TRUE_CRITERION = 'A concrete reason to reject.';
const DEALBREAKER_FALSE_CRITERION =
  'No concrete reject reason, including a thin title.';

const ITEM_ID_PATTERN = /\/marketplace\/item\/(\d+)/;

export function itemId(href: string): string | null {
  const match = ITEM_ID_PATTERN.exec(href);
  return match?.[1] ?? null;
}

interface NormalizedBrief {
  query: string;
  maxPrice: number | null;
  currency: BriefCurrency;
  places: string[];
  note: string;
}

function normalizeBrief(brief: Brief): NormalizedBrief {
  return {
    query: brief.query,
    maxPrice: brief.maxPrice ?? null,
    currency: brief.currency ?? 'ARS',
    places: brief.places ?? [],
    note: brief.note ?? '',
  };
}

interface ParsedTile {
  title: string;
  price: number | null;
  currency: string | null;
  place: string;
}

const FREE_PATTERN = /\b(free|gratis)\b/i;

// Symbol prefixes before the amount. Longer markers come first so `US$`
// wins over a bare `$`.
const SYMBOL_PREFIX_PATTERN = /US\$|U\$S|R\$|MX\$|\$|€|£/y;
const CODE_PATTERN =
  /USD|ARS|EUR|GBP|BRL|CLP|COP|MXN|PEN|UYU|PYG|BOB|CAD|AUD|CHF|Bs/i;
const LISTING_ID_SUFFIX_PATTERN =
  /,?\s*\b(listing\s*(id)?|item\s*(id)?|id)\s*#?:?\s*\d+\s*$/i;

function canonicalCurrency(marker: string, briefCurrency: BriefCurrency): string {
  const upper = marker.toUpperCase();
  if (marker === '$') return briefCurrency;
  if (upper === 'US$' || upper === 'U$S' || upper === 'USD') return 'USD';
  if (upper === 'ARS') return 'ARS';
  return upper;
}

// Thousand separators read as one integer (`250.000` is 250000); a trailing
// separator with one or two digits is a decimal (`1.234,56` is 1234.56).
// Exported for the side panel's max-price input, which reads the same way.
export function parseAmount(raw: string): number {
  const compact = raw.replace(/\s+/g, '').replace(/[.,]+$/, '');
  const trailing = /[.,](\d{1,2})$/.exec(compact);
  if (trailing?.[1] !== undefined) {
    const head = compact.slice(0, compact.length - trailing[0].length);
    return parseFloat(`${head.replace(/[.,]/g, '')}.${trailing[1]}`);
  }
  return parseInt(compact.replace(/[.,]/g, ''), 10);
}

interface PriceCandidate {
  amount: number;
  currency: string;
  start: number;
  end: number;
}

function scanExplicitPrices(
  name: string,
  briefCurrency: BriefCurrency,
): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  // Amounts start and end with a digit so a scan never eats the comma that
  // separates the price segment from the place.
  const amount = '\\d(?:[\\d.,]*\\d)?';
  // Symbol prefix: `$ 250.000`, `US$ 200`.
  const symbolPattern = new RegExp(
    `(${SYMBOL_PREFIX_PATTERN.source})\\s*(${amount})`,
    'gi',
  );
  for (const match of name.matchAll(symbolPattern)) {
    const marker = match[1] ?? '';
    const raw = match[2] ?? '';
    const start = match.index ?? 0;
    candidates.push({
      amount: parseAmount(raw),
      currency: canonicalCurrency(marker, briefCurrency),
      start,
      end: start + match[0].length,
    });
  }
  // Letter code before or after the amount: `USD 200`, `200 ARS`.
  const codePattern = new RegExp(
    `(?:(${CODE_PATTERN.source})\\s*(${amount})|(${amount})\\s*(${CODE_PATTERN.source}))\\b`,
    'gi',
  );
  for (const match of name.matchAll(codePattern)) {
    const marker = (match[1] ?? match[4] ?? '').toUpperCase();
    const raw = match[2] ?? match[3] ?? '';
    // A bare `$` already covered above; skip code matches that overlap one.
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (candidates.some((c) => start < c.end && end > c.start)) continue;
    candidates.push({
      amount: parseAmount(raw),
      currency: canonicalCurrency(marker, briefCurrency),
      start,
      end,
    });
  }
  return candidates.sort((a, b) => a.start - b.start);
}

function scanBareSegmentPrice(segment: string): number | null {
  const trimmed = segment.trim();
  if (trimmed === '') return null;
  // Only a bare number (or range) standing alone as its own segment counts;
  // title words with digits such as `iPhone 13` never do.
  if (!/^\d[\d.,\s]*(?:\s*[-–—]\s*\d[\d.,\s]*)?$/.test(trimmed)) return null;
  const parts = trimmed.split(/\s*[-–—]\s*/);
  const amounts = parts.map((part) => parseAmount(part));
  return Math.min(...amounts);
}

function removeSpan(name: string, start: number, end: number): string {
  return `${name.slice(0, start)} ${name.slice(end)}`;
}

function parseTile(name: string, briefCurrency: BriefCurrency): ParsedTile {
  let working = name;
  let price: number | null = null;
  let currency: string | null = null;

  // An explicit number beats the words: `free shipping` next to a real price
  // is not the price.
  const explicit = scanExplicitPrices(working, briefCurrency);
  const freeMatch = explicit.length === 0 ? FREE_PATTERN.exec(working) : null;
  if (freeMatch?.index !== undefined) {
    price = 0;
    currency = briefCurrency;
    working = removeSpan(working, freeMatch.index, freeMatch.index + freeMatch[0].length);
  } else if (explicit.length > 0) {
    // A range judges its lower amount. A bare partner next to an explicit
    // price (`$100-200`) joins the range under the explicit currency.
    const amounts = explicit.map((c) => c.amount);
    let start = explicit[0]!.start;
    let end = explicit[explicit.length - 1]!.end;
    const before = working.slice(0, start);
    const beforeMatch = /(\d(?:[\d.,]*\d)?)\s*[-–—]\s*$/.exec(before);
    if (beforeMatch?.[1] !== undefined) {
      amounts.push(parseAmount(beforeMatch[1]));
      start -= beforeMatch[0].length;
    }
    const after = working.slice(end);
    const afterMatch = /^\s*[-–—]\s*(\d(?:[\d.,]*\d)?)/.exec(after);
    if (afterMatch?.[1] !== undefined) {
      amounts.push(parseAmount(afterMatch[1]));
      end += afterMatch[0].length;
    }
    const first = explicit[0]!;
    price = Math.min(...amounts);
    currency = first.currency;
    working = removeSpan(working, start, end);
  } else {
    for (const segment of working.split(',')) {
      const bare = scanBareSegmentPrice(segment);
      if (bare !== null) {
        price = bare;
        currency = briefCurrency;
        const at = working.indexOf(segment);
        working = removeSpan(working, at, at + segment.length);
        break;
      }
    }
  }

  working = working.replace(LISTING_ID_SUFFIX_PATTERN, '');
  const segments = working
    .split(',')
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment !== '');
  if (segments.length === 0) return { title: '', price, currency, place: '' };
  if (segments.length === 1) {
    return { title: segments[0]!, price, currency, place: '' };
  }
  return {
    title: segments.slice(0, -1).join(', '),
    price,
    currency,
    place: segments[segments.length - 1]!,
  };
}

function localReasonFor(
  parsed: ParsedTile,
  brief: NormalizedBrief,
): LocalReason | null {
  // Currency first: without a shared unit there is no meaningful cap check,
  // and there is no exchange rate.
  if (parsed.currency !== null && parsed.currency !== brief.currency) {
    return 'currency';
  }
  if (parsed.price === null) {
    if (brief.maxPrice !== null) return 'no price';
  } else if (brief.maxPrice !== null && parsed.price > brief.maxPrice) {
    return 'price';
  }
  const wanted = brief.places.map((place) => place.trim()).filter((p) => p !== '');
  if (wanted.length > 0) {
    const place = parsed.place.toLowerCase();
    const hit =
      place !== '' &&
      wanted.some((sub) => place.includes(sub.toLowerCase()));
    if (!hit) return 'location';
  }
  return null;
}

function fitQuestionName(id: string): string {
  return `fit-${id}`;
}

function dealbreakerQuestionName(id: string): string {
  return `dealbreaker-${id}`;
}

function decideVerdict(
  fit: number,
  confidence: number,
  dealbreaker: number,
): Verdict {
  if (dealbreaker >= DEALBREAKER_SKIP_AT) return 'SKIP';
  if (confidence < LOW_CONFIDENCE_REVIEW_BELOW) return 'REVIEW';
  if (fit >= FIT_MATCH_AT) return 'MATCH';
  if (fit < FIT_SKIP_BELOW) return 'SKIP';
  return 'REVIEW';
}

export interface Judgment {
  id: string;
  title: string;
  verdict: Verdict;
  // Model scores are null on a local SKIP, which carries a reason instead.
  fit: number | null;
  fitConfidence: number | null;
  dealbreaker: number | null;
  reason: LocalReason | null;
  ms: number | null;
  price: number | null;
  currency: string | null;
  place: string;
  // Hash of the brief this judgment was scored under. A grid judgment is
  // reused only when the item id, price, currency, and brief all match.
  briefHash: string;
  // True for a judgment scored with the opened description. One item id can
  // hold a grid entry and a described entry; the described one wins on screen.
  described: boolean;
  // The description the described judgment was scored with. Null on grid and
  // local judgments. A later open reuses it only when the description matches.
  description: string | null;
}

// The browser-session cache: everything a reloaded page needs to repaint
// without paying again. Persisted in session storage, so it survives a
// reload but never a browser restart. The brief and the key live in local
// storage and do survive restarts.
export interface SessionSnapshot {
  judgments: Judgment[];
  scanned: number;
  totalCost: number;
  lastMs: number | null;
  lastError: string | null;
  briefHash: string | null;
}

// Identity of a brief for the score cache. Any edit to the query, max
// price, currency, place list, or note is a new identity and drops every
// stored judgment. The content script shares this function so both layers
// always agree on whether the brief changed.
export function briefHashFor(brief: Brief): string {
  return briefHash(normalizeBrief(brief));
}

function briefHash(brief: NormalizedBrief): string {
  const canonical = JSON.stringify({
    query: brief.query,
    maxPrice: brief.maxPrice,
    currency: brief.currency,
    places: brief.places,
    note: brief.note,
  });
  // FNV-1a over the canonical brief: deterministic, no dependencies.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

interface ParsedAnswers {
  fit: number;
  confidence: number;
  dealbreaker: number;
}

function parseAnswers(
  answers: Record<string, AnswerValue>,
  id: string,
): ParsedAnswers | null {
  const fit = answers[fitQuestionName(id)];
  const dealbreaker = answers[dealbreakerQuestionName(id)];
  if (
    fit?.kind !== 'score' ||
    typeof fit.value !== 'number' ||
    typeof fit.confidence !== 'number' ||
    dealbreaker?.kind !== 'noul' ||
    typeof dealbreaker.probabilityTrue !== 'number'
  ) {
    return null;
  }
  return {
    fit: fit.value,
    confidence: fit.confidence,
    dealbreaker: dealbreaker.probabilityTrue,
  };
}

function badgeFor(judgment: Judgment): Badge {
  if (judgment.reason !== null) {
    return { id: judgment.id, text: `SKIP ${judgment.reason}`, tone: 'skip' };
  }
  return {
    id: judgment.id,
    text: `${judgment.verdict} ${(judgment.fit ?? 0).toFixed(1)}`,
    tone: judgment.verdict.toLowerCase() as BadgeTone,
  };
}

const VERDICT_RANK: Record<Verdict, number> = {
  MATCH: 0,
  REVIEW: 1,
  SKIP: 2,
};

function compareVerdictFit(
  a: { verdict: Verdict; fit: number | null },
  b: { verdict: Verdict; fit: number | null },
): number {
  if (VERDICT_RANK[a.verdict] !== VERDICT_RANK[b.verdict]) {
    return VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
  }
  // Higher fit first; a local SKIP (no fit) follows model SKIP entries.
  return (b.fit ?? -1) - (a.fit ?? -1);
}

function compareEntries(a: PanelEntry, b: PanelEntry): number {
  return compareVerdictFit(a, b);
}

function compareJudgments(a: Judgment, b: Judgment): number {
  return compareVerdictFit(a, b);
}

// CSV export (#7): one row per item id, the described judgment winning when
// both exist. Columns in order: id, title, price, currency, location, url,
// verdict, fit, fit confidence, dealbreaker, reason, milliseconds. Model
// rows fill the score fields and leave reason empty; local SKIP rows fill
// reason and leave the score fields and milliseconds empty.
export const CSV_COLUMNS: readonly string[] = [
  'id',
  'title',
  'price',
  'currency',
  'location',
  'url',
  'verdict',
  'fit',
  'fit confidence',
  'dealbreaker',
  'reason',
  'milliseconds',
];

export const CSV_HEADER: string = CSV_COLUMNS.join(',');

export function csvUrlFor(id: string): string {
  return `https://www.facebook.com/marketplace/item/${id}/`;
}

export function escapeCsvField(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function judgmentToCsvRow(judgment: Judgment): string {
  const fields = [
    judgment.id,
    judgment.title,
    judgment.price === null ? '' : `${judgment.price}`,
    judgment.currency ?? '',
    judgment.place,
    csvUrlFor(judgment.id),
    judgment.verdict,
    judgment.fit === null ? '' : `${judgment.fit}`,
    judgment.fitConfidence === null ? '' : `${judgment.fitConfidence}`,
    judgment.dealbreaker === null ? '' : `${judgment.dealbreaker}`,
    judgment.reason ?? '',
    judgment.ms === null ? '' : `${judgment.ms}`,
  ];
  return fields.map(escapeCsvField).join(',');
}

export function judgmentsToCsv(judgments: Judgment[]): string {
  return [CSV_HEADER, ...judgments.map(judgmentToCsvRow)].join('\n');
}

function cacheKey(id: string, described: boolean): string {
  return `${described ? 'described' : 'grid'}:${id}`;
}

export class MarketplaceSession {
  // One item id can hold a grid entry and a described entry; the described
  // one wins on screen. Local SKIP judgments live in the grid slot.
  private readonly judgments = new Map<string, Judgment>();
  private scanned = 0;
  private totalCost = 0;
  private lastMs: number | null = null;
  private lastError: string | null = null;
  private briefHash: string | null = null;

  constructor(
    private readonly gateway: Gateway,
    snapshot?: SessionSnapshot | null,
  ) {
    if (snapshot !== undefined && snapshot !== null) {
      for (const judgment of snapshot.judgments ?? []) {
        // Older snapshots predate described judgments; they load as grid.
        const described = (judgment as Partial<Judgment>).described ?? false;
        const description = (judgment as Partial<Judgment>).description ?? null;
        const full: Judgment = { ...judgment, described, description };
        this.judgments.set(cacheKey(full.id, full.described), full);
      }
      this.scanned = snapshot.scanned;
      this.totalCost = snapshot.totalCost;
      this.lastMs = snapshot.lastMs;
      this.lastError = snapshot.lastError;
      this.briefHash = snapshot.briefHash;
    }
  }

  // Captures the browser-session cache for session storage. The copy is
  // detached: later waves never mutate a snapshot already handed out.
  snapshot(): SessionSnapshot {
    return {
      judgments: [...this.judgments.values()].map((judgment) => ({ ...judgment })),
      scanned: this.scanned,
      totalCost: this.totalCost,
      lastMs: this.lastMs,
      lastError: this.lastError,
      briefHash: this.briefHash,
    };
  }

  // The current panel without sending or counting: for the side panel's
  // first paint.
  preview(brief: Brief, keyPresent: boolean): PanelModel {
    if (brief.query.trim() === '') {
      return this.panel('need-query', NEED_QUERY_NOTICE);
    }
    if (!keyPresent) {
      return this.panel('need-key', NEED_KEY_NOTICE);
    }
    return this.panel('ready', null);
  }

  // Every judgment kept for this browser session as CSV, including listings
  // that have left the grid. One row per item id in panel order; the
  // described judgment wins when both exist.
  exportCsv(): string {
    return judgmentsToCsv(this.preferred().sort(compareJudgments));
  }

  // Alias kept for callers that name the conversion rather than the download.
  toCsv(): string {
    return this.exportCsv();
  }

  async judgeWave(
    brief: Brief,
    snapshots: TileSnapshot[],
    keyPresent: boolean,
  ): Promise<WaveResult> {
    const normalized = normalizeBrief(brief);
    if (normalized.query.trim() === '') {
      return {
        badges: [],
        unpainted: [],
        panel: this.panel('need-query', NEED_QUERY_NOTICE),
      };
    }
    const hash = briefHash(normalized);
    if (this.briefHash !== hash) {
      // A new brief drops every stored judgment, including listings that
      // have left the grid, and the wave below rescores the screen fresh.
      this.judgments.clear();
      this.briefHash = hash;
    }
    const considered = snapshots.filter(
      (snapshot) => itemId(snapshot.href) !== null,
    );
    this.scanned += considered.length;

    // Parse once per item id; repeated tiles of one item share the first
    // snapshot. Hard limits split local SKIP badges from Jev survivors.
    // The product query is model context only, never a title word match.
    // A snapshot carrying a description is an opened listing: it never joins
    // a grid chunk and a grid judgment never satisfies it.
    const parsed = new Map<string, ParsedTile>();
    const descriptions = new Map<string, string | undefined>();
    const order: string[] = [];
    for (const snapshot of considered) {
      const id = itemId(snapshot.href) as string;
      if (!parsed.has(id)) {
        parsed.set(id, parseTile(snapshot.name, normalized.currency));
        descriptions.set(id, snapshot.description);
        order.push(id);
      }
    }
    // Badges that cost no call: fresh local SKIP badges plus stored
    // judgments whose item id, price, currency, and brief still match. Grid
    // tiles prefer the described entry when both match; opened tiles only
    // reuse a described entry with the same description.
    const freeBadges: Badge[] = [];
    const survivors: ListingState[] = [];
    const openedSurvivors: ListingState[] = [];
    for (const id of order) {
      const tile = parsed.get(id)!;
      const description = descriptions.get(id);
      if (description !== undefined) {
        const cached = this.describedFor(id);
        if (
          cached !== undefined &&
          cached.price === tile.price &&
          cached.currency === tile.currency &&
          cached.briefHash === hash &&
          cached.description === description
        ) {
          freeBadges.push(badgeFor(cached));
          continue;
        }
        const reason = localReasonFor(tile, normalized);
        if (reason !== null) {
          const judgment = this.localJudgment(id, tile, reason, hash);
          this.storeLocal(judgment);
          freeBadges.push(badgeFor(judgment));
        } else {
          openedSurvivors.push({
            id,
            title: tile.title,
            price: tile.price,
            currency: tile.currency,
            place: tile.place,
            description,
          });
        }
        continue;
      }
      const described = this.describedFor(id);
      if (
        described !== undefined &&
        described.price === tile.price &&
        described.currency === tile.currency &&
        described.briefHash === hash
      ) {
        freeBadges.push(badgeFor(described));
        continue;
      }
      const cached = this.gridFor(id);
      if (
        cached !== undefined &&
        cached.price === tile.price &&
        cached.currency === tile.currency &&
        cached.briefHash === hash
      ) {
        freeBadges.push(badgeFor(cached));
        continue;
      }
      const reason = localReasonFor(tile, normalized);
      if (reason !== null) {
        const judgment = this.localJudgment(id, tile, reason, hash);
        this.storeLocal(judgment);
        freeBadges.push(badgeFor(judgment));
      } else {
        survivors.push({
          id,
          title: tile.title,
          price: tile.price,
          currency: tile.currency,
          place: tile.place,
        });
      }
    }

    // Local rejects and stored judgments paint without a key; unsent
    // survivors wait for one. Survivors stay out of `unpainted` so the
    // content script retries them once a key (or query) unlocks the wave.
    if (!keyPresent) {
      return {
        badges: freeBadges,
        unpainted: [],
        panel: this.panel('need-key', NEED_KEY_NOTICE),
      };
    }

    const badges: Badge[] = [...freeBadges];
    const unpainted: string[] = [];
    let waveError: string | null = null;
    for (let start = 0; start < survivors.length; start += CHUNK_SIZE) {
      const chunk = survivors.slice(start, start + CHUNK_SIZE);
      const result = await this.gateway.send(this.requestFor(normalized, chunk));
      this.lastMs = result.ms;
      if (!result.ok) {
        waveError ??= result.error;
        unpainted.push(...chunk.map((listing) => listing.id));
        continue;
      }
      this.totalCost += result.cost;
      for (const listing of chunk) {
        const answers = parseAnswers(result.answers, listing.id);
        if (answers === null) {
          waveError ??= `Jev omitted the answers for listing ${listing.id}.`;
          unpainted.push(listing.id);
          continue;
        }
        const judgment = this.modelJudgment(listing, answers, result.ms, hash, false, null);
        this.storeGrid(judgment);
        badges.push(badgeFor(judgment));
      }
    }
    for (const listing of openedSurvivors) {
      const single = await this.sendOpened(normalized, listing, hash);
      badges.push(...single.badges);
      unpainted.push(...single.unpainted);
      waveError ??= single.error;
    }
    this.lastError = waveError;

    return { badges, unpainted, panel: this.panel('ready', null) };
  }

  // Judges listings the shopper opened, each as its own request with the
  // description. A grid judgment never satisfies an open; a later open with
  // the same item, price, currency, brief, and description reuses the
  // described judgment. A local SKIP is never sent.
  async judgeOpened(
    brief: Brief,
    snapshotOrSnapshots: TileSnapshot | TileSnapshot[],
    keyPresent: boolean,
  ): Promise<WaveResult> {
    const snapshots = Array.isArray(snapshotOrSnapshots)
      ? snapshotOrSnapshots
      : [snapshotOrSnapshots];
    const normalized = normalizeBrief(brief);
    if (normalized.query.trim() === '') {
      return {
        badges: [],
        unpainted: [],
        panel: this.panel('need-query', NEED_QUERY_NOTICE),
      };
    }
    const hash = briefHash(normalized);
    if (this.briefHash !== hash) {
      this.judgments.clear();
      this.briefHash = hash;
    }
    const considered = snapshots.filter(
      (snapshot) => itemId(snapshot.href) !== null,
    );
    this.scanned += considered.length;

    const parsed = new Map<string, ParsedTile>();
    const descriptions = new Map<string, string>();
    const order: string[] = [];
    for (const snapshot of considered) {
      const id = itemId(snapshot.href) as string;
      if (!parsed.has(id)) {
        parsed.set(id, parseTile(snapshot.name, normalized.currency));
        descriptions.set(id, snapshot.description ?? '');
        order.push(id);
      }
    }
    const freeBadges: Badge[] = [];
    const survivors: ListingState[] = [];
    for (const id of order) {
      const tile = parsed.get(id)!;
      const description = descriptions.get(id) ?? '';
      const cached = this.describedFor(id);
      if (
        cached !== undefined &&
        cached.price === tile.price &&
        cached.currency === tile.currency &&
        cached.briefHash === hash &&
        cached.description === description
      ) {
        freeBadges.push(badgeFor(cached));
        continue;
      }
      const reason = localReasonFor(tile, normalized);
      if (reason !== null) {
        const judgment = this.localJudgment(id, tile, reason, hash);
        this.storeLocal(judgment);
        freeBadges.push(badgeFor(judgment));
      } else {
        survivors.push({
          id,
          title: tile.title,
          price: tile.price,
          currency: tile.currency,
          place: tile.place,
          description,
        });
      }
    }

    if (!keyPresent) {
      return {
        badges: freeBadges,
        unpainted: [],
        panel: this.panel('need-key', NEED_KEY_NOTICE),
      };
    }

    const badges: Badge[] = [...freeBadges];
    const unpainted: string[] = [];
    let waveError: string | null = null;
    for (const listing of survivors) {
      const single = await this.sendOpened(normalized, listing, hash);
      badges.push(...single.badges);
      unpainted.push(...single.unpainted);
      waveError ??= single.error;
    }
    this.lastError = waveError;

    return { badges, unpainted, panel: this.panel('ready', null) };
  }

  // Judges the survivors currently on screen again, ignoring the stored
  // judgment for each of them. Local SKIP tiles on screen stay local and
  // unsent. Tiles that are not on screen keep their stored judgments: only
  // the ids in this call are ever replaced. A failed chunk leaves those ids
  // unpainted relative to this attempt without clearing their stored
  // judgments, records the error, and schedules no retry.
  async rescore(
    brief: Brief,
    snapshots: TileSnapshot[],
    keyPresent: boolean,
  ): Promise<WaveResult> {
    const normalized = normalizeBrief(brief);
    if (normalized.query.trim() === '') {
      return {
        badges: [],
        unpainted: [],
        panel: this.panel('need-query', NEED_QUERY_NOTICE),
      };
    }
    const hash = briefHash(normalized);
    if (this.briefHash !== hash) {
      this.judgments.clear();
      this.briefHash = hash;
    }
    const considered = snapshots.filter(
      (snapshot) => itemId(snapshot.href) !== null,
    );
    this.scanned += considered.length;

    const parsed = new Map<string, ParsedTile>();
    const descriptions = new Map<string, string | undefined>();
    const order: string[] = [];
    for (const snapshot of considered) {
      const id = itemId(snapshot.href) as string;
      if (!parsed.has(id)) {
        parsed.set(id, parseTile(snapshot.name, normalized.currency));
        descriptions.set(id, snapshot.description);
        order.push(id);
      }
    }
    const freeBadges: Badge[] = [];
    const survivors: ListingState[] = [];
    const openedSurvivors: ListingState[] = [];
    for (const id of order) {
      const tile = parsed.get(id)!;
      const reason = localReasonFor(tile, normalized);
      if (reason !== null) {
        const judgment = this.localJudgment(id, tile, reason, hash);
        this.storeLocal(judgment);
        freeBadges.push(badgeFor(judgment));
        continue;
      }
      const description = descriptions.get(id);
      if (description !== undefined) {
        openedSurvivors.push({
          id,
          title: tile.title,
          price: tile.price,
          currency: tile.currency,
          place: tile.place,
          description,
        });
      } else {
        survivors.push({
          id,
          title: tile.title,
          price: tile.price,
          currency: tile.currency,
          place: tile.place,
        });
      }
    }

    if (!keyPresent) {
      return {
        badges: freeBadges,
        unpainted: [],
        panel: this.panel('need-key', NEED_KEY_NOTICE),
      };
    }

    const badges: Badge[] = [...freeBadges];
    const unpainted: string[] = [];
    let waveError: string | null = null;
    for (let start = 0; start < survivors.length; start += CHUNK_SIZE) {
      const chunk = survivors.slice(start, start + CHUNK_SIZE);
      const result = await this.gateway.send(this.requestFor(normalized, chunk));
      this.lastMs = result.ms;
      if (!result.ok) {
        waveError ??= result.error;
        unpainted.push(...chunk.map((listing) => listing.id));
        continue;
      }
      this.totalCost += result.cost;
      for (const listing of chunk) {
        const answers = parseAnswers(result.answers, listing.id);
        if (answers === null) {
          waveError ??= `Jev omitted the answers for listing ${listing.id}.`;
          unpainted.push(listing.id);
          continue;
        }
        const judgment = this.modelJudgment(listing, answers, result.ms, hash, false, null);
        // The fresh grid verdict replaces the badge, so a described entry
        // for the same item drops instead of keeping the win on screen.
        this.judgments.delete(cacheKey(listing.id, true));
        this.storeGrid(judgment);
        badges.push(badgeFor(judgment));
      }
    }
    for (const listing of openedSurvivors) {
      const single = await this.sendOpened(normalized, listing, hash);
      if (single.badges.length > 0) {
        // The fresh described verdict is the single entry for the item; the
        // pre-rescore grid entry drops with it. Failures leave both alone.
        this.judgments.delete(cacheKey(listing.id, false));
      }
      badges.push(...single.badges);
      unpainted.push(...single.unpainted);
      waveError ??= single.error;
    }
    this.lastError = waveError;

    return { badges, unpainted, panel: this.panel('ready', null) };
  }

  private gridFor(id: string): Judgment | undefined {
    return this.judgments.get(cacheKey(id, false));
  }

  private describedFor(id: string): Judgment | undefined {
    return this.judgments.get(cacheKey(id, true));
  }

  // Stores a grid model judgment. A stale described entry (different price,
  // currency, or brief) drops; a current one stays and keeps winning.
  private storeGrid(judgment: Judgment): void {
    this.judgments.set(cacheKey(judgment.id, false), judgment);
    const described = this.describedFor(judgment.id);
    if (
      described !== undefined &&
      (described.price !== judgment.price ||
        described.currency !== judgment.currency ||
        described.briefHash !== judgment.briefHash)
    ) {
      this.judgments.delete(cacheKey(judgment.id, true));
    }
  }

  // Stores a described judgment. A stale grid entry drops; a current one
  // stays beside it with the described entry winning on screen.
  private storeDescribed(judgment: Judgment): void {
    this.judgments.set(cacheKey(judgment.id, true), judgment);
    const grid = this.gridFor(judgment.id);
    if (
      grid !== undefined &&
      (grid.price !== judgment.price ||
        grid.currency !== judgment.currency ||
        grid.briefHash !== judgment.briefHash)
    ) {
      this.judgments.delete(cacheKey(judgment.id, false));
    }
  }

  // A local SKIP always wins for its item: it overwrites the grid slot and
  // clears any described entry, so a stale model verdict cannot resurface.
  private storeLocal(judgment: Judgment): void {
    this.judgments.set(cacheKey(judgment.id, false), judgment);
    this.judgments.delete(cacheKey(judgment.id, true));
  }

  private localJudgment(
    id: string,
    tile: ParsedTile,
    reason: LocalReason,
    hash: string,
  ): Judgment {
    return {
      id,
      title: tile.title,
      verdict: 'SKIP',
      fit: null,
      fitConfidence: null,
      dealbreaker: null,
      reason,
      ms: null,
      price: tile.price,
      currency: tile.currency,
      place: tile.place,
      briefHash: hash,
      described: false,
      description: null,
    };
  }

  private modelJudgment(
    listing: ListingState,
    answers: { fit: number; confidence: number; dealbreaker: number },
    ms: number,
    hash: string,
    described: boolean,
    description: string | null,
  ): Judgment {
    return {
      id: listing.id,
      title: listing.title,
      verdict: decideVerdict(answers.fit, answers.confidence, answers.dealbreaker),
      fit: answers.fit,
      fitConfidence: answers.confidence,
      dealbreaker: answers.dealbreaker,
      reason: null,
      ms,
      price: listing.price,
      currency: listing.currency,
      place: listing.place,
      briefHash: hash,
      described,
      description,
    };
  }

  // One request for one opened listing. Failures and omitted answers leave
  // the listing unpainted without clearing the grid judgment beside it.
  private async sendOpened(
    brief: NormalizedBrief,
    listing: ListingState,
    hash: string,
  ): Promise<{ badges: Badge[]; unpainted: string[]; error: string | null }> {
    const result = await this.gateway.send(this.requestFor(brief, [listing]));
    this.lastMs = result.ms;
    if (!result.ok) {
      return { badges: [], unpainted: [listing.id], error: result.error };
    }
    this.totalCost += result.cost;
    const answers = parseAnswers(result.answers, listing.id);
    if (answers === null) {
      return {
        badges: [],
        unpainted: [listing.id],
        error: `Jev omitted the answers for listing ${listing.id}.`,
      };
    }
    const judgment = this.modelJudgment(
      listing,
      answers,
      result.ms,
      hash,
      true,
      listing.description ?? '',
    );
    this.storeDescribed(judgment);
    return { badges: [badgeFor(judgment)], unpainted: [], error: null };
  }

  private requestFor(brief: NormalizedBrief, chunk: ListingState[]): DecisionRequest {
    const questions: DecisionQuestion[] = [];
    for (const listing of chunk) {
      questions.push(
        {
          kind: 'score',
          name: fitQuestionName(listing.id),
          instruction: FIT_INSTRUCTION,
          levels: FIT_LEVELS,
        },
        {
          kind: 'noul',
          name: dealbreakerQuestionName(listing.id),
          instruction: DEALBREAKER_INSTRUCTION,
          trueCriterion: DEALBREAKER_TRUE_CRITERION,
          falseCriterion: DEALBREAKER_FALSE_CRITERION,
        },
      );
    }
    return {
      model: MODEL_ID,
      state: { query: brief.query, note: brief.note, listings: chunk },
      questions,
    };
  }

  // One entry per item id; the described judgment wins when both exist.
  private preferred(): Judgment[] {
    const byId = new Map<string, Judgment>();
    for (const judgment of this.judgments.values()) {
      const existing = byId.get(judgment.id);
      if (existing === undefined || (judgment.described && !existing.described)) {
        byId.set(judgment.id, judgment);
      }
    }
    return [...byId.values()];
  }

  private panel(status: PanelStatus, notice: string | null): PanelModel {
    const entries = this.preferred()
      .map((judgment) => ({
        id: judgment.id,
        title: judgment.title,
        verdict: judgment.verdict,
        fit: judgment.fit,
        reason: judgment.reason,
      }))
      .sort(compareEntries);
    return {
      status,
      notice,
      entries,
      scanned: this.scanned,
      kept: entries.filter((entry) => entry.verdict === 'MATCH').length,
      skipped: entries.filter((entry) => entry.verdict === 'SKIP').length,
      review: entries.filter((entry) => entry.verdict === 'REVIEW').length,
      lastMs: this.lastMs,
      totalCost: this.totalCost,
      error: this.lastError,
    };
  }
}
