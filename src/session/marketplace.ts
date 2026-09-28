// Behavioral core for the Deal Hunter grid slice (#2).
//
// The marketplace session decides verdicts. Adapters (tile reader, Jev gateway,
// grid painter, side panel, stores) surround it and are not covered by tests.
// Tests script the gateway, so nothing here touches the DOM or the network.

export interface Brief {
  query: string;
}

export interface TileSnapshot {
  href: string;
  name: string;
}

export interface ListingState {
  id: string;
  title: string;
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
  fit: number;
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

interface Judgment {
  id: string;
  title: string;
  verdict: Verdict;
  fit: number;
  fitConfidence: number;
  dealbreaker: number;
  ms: number;
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
  return {
    id: judgment.id,
    text: `${judgment.verdict} ${judgment.fit.toFixed(1)}`,
    tone: judgment.verdict.toLowerCase() as BadgeTone,
  };
}

const VERDICT_RANK: Record<Verdict, number> = {
  MATCH: 0,
  REVIEW: 1,
  SKIP: 2,
};

function compareEntries(a: PanelEntry, b: PanelEntry): number {
  return (
    VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.fit - a.fit
  );
}

export class MarketplaceSession {
  private readonly judgments = new Map<string, Judgment>();
  private scanned = 0;
  private totalCost = 0;
  private lastMs: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly gateway: Gateway) {}

  // The current panel without sending or counting: for the side panel's
  // first paint and for brief edits that must not rescore (#4 owns rescore).
  preview(brief: Brief, keyPresent: boolean): PanelModel {
    if (brief.query.trim() === '') {
      return this.panel('need-query', NEED_QUERY_NOTICE);
    }
    if (!keyPresent) {
      return this.panel('need-key', NEED_KEY_NOTICE);
    }
    return this.panel('ready', null);
  }

  async judgeWave(
    brief: Brief,
    snapshots: TileSnapshot[],
    keyPresent: boolean,
  ): Promise<WaveResult> {
    if (brief.query.trim() === '') {
      return {
        badges: [],
        unpainted: [],
        panel: this.panel('need-query', NEED_QUERY_NOTICE),
      };
    }
    const considered = snapshots.filter(
      (snapshot) => itemId(snapshot.href) !== null,
    );
    this.scanned += considered.length;
    if (!keyPresent) {
      return {
        badges: [],
        unpainted: [],
        panel: this.panel('need-key', NEED_KEY_NOTICE),
      };
    }

    const targets = new Map<string, ListingState>();
    for (const snapshot of considered) {
      const id = itemId(snapshot.href) as string;
      if (!targets.has(id)) {
        targets.set(id, { id, title: snapshot.name });
      }
    }

    const badges: Badge[] = [];
    const unpainted: string[] = [];
    let waveError: string | null = null;
    const listings = [...targets.values()];
    for (let start = 0; start < listings.length; start += CHUNK_SIZE) {
      const chunk = listings.slice(start, start + CHUNK_SIZE);
      const result = await this.gateway.send(this.requestFor(brief, chunk));
      this.lastMs = result.ms;
      if (!result.ok) {
        waveError ??= result.error;
        unpainted.push(...chunk.map((listing) => listing.id));
        continue;
      }
      this.totalCost += result.cost;
      for (const listing of chunk) {
        const parsed = parseAnswers(result.answers, listing.id);
        if (parsed === null) {
          waveError ??= `Jev omitted the answers for listing ${listing.id}.`;
          unpainted.push(listing.id);
          continue;
        }
        const judgment: Judgment = {
          id: listing.id,
          title: listing.title,
          verdict: decideVerdict(parsed.fit, parsed.confidence, parsed.dealbreaker),
          fit: parsed.fit,
          fitConfidence: parsed.confidence,
          dealbreaker: parsed.dealbreaker,
          ms: result.ms,
        };
        this.judgments.set(listing.id, judgment);
        badges.push(badgeFor(judgment));
      }
    }
    this.lastError = waveError;

    return { badges, unpainted, panel: this.panel('ready', null) };
  }

  private requestFor(brief: Brief, chunk: ListingState[]): DecisionRequest {
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
      state: { query: brief.query, note: '', listings: chunk },
      questions,
    };
  }

  private panel(status: PanelStatus, notice: string | null): PanelModel {
    const entries = [...this.judgments.values()]
      .map((judgment) => ({
        id: judgment.id,
        title: judgment.title,
        verdict: judgment.verdict,
        fit: judgment.fit,
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
