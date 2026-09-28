import { describe, expect, it } from 'vitest';
import { MarketplaceSession } from '../src/session/marketplace';
import type {
  AnswerValue,
  DecisionRequest,
  Gateway,
  GatewayResult,
} from '../src/session/marketplace';

type Responder = (request: DecisionRequest) => GatewayResult;

interface ScriptedVerdict {
  fit: number;
  confidence: number;
  dealbreaker: number;
}

// Builds answers for whatever question names the session chose, as long as
// each name carries its listing id. Test ids must not be substrings of each other.
function answersFor(
  perId: Record<string, ScriptedVerdict>,
  ms = 120,
  cost = 0.001,
): Responder {
  return (request) => {
    const ids = request.state.listings.map((listing) => listing.id);
    const answers: Record<string, AnswerValue> = {};
    for (const question of request.questions) {
      const id = ids.find((candidate) => question.name.includes(candidate));
      if (id === undefined) {
        throw new Error(`question name carries no listing id: ${question.name}`);
      }
      const scripted = perId[id];
      if (scripted === undefined) {
        throw new Error(`no scripted answers for listing ${id}`);
      }
      answers[question.name] =
        question.kind === 'score'
          ? { kind: 'score', value: scripted.fit, confidence: scripted.confidence }
          : { kind: 'noul', probabilityTrue: scripted.dealbreaker };
    }
    return { ok: true, answers, ms, cost };
  };
}

class ScriptedGateway implements Gateway {
  requests: DecisionRequest[] = [];

  constructor(private readonly respond: Responder) {}

  async send(request: DecisionRequest): Promise<GatewayResult> {
    this.requests.push(request);
    return this.respond(request);
  }
}

const ok = (ms = 120, cost = 0.001): GatewayResult => ({
  ok: true,
  answers: {},
  ms,
  cost,
});

describe('marketplace session', () => {
  it('asks for a query and sends nothing when the query is empty', async () => {
    const gateway = new ScriptedGateway(() => ok());
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: '' },
      [
        {
          href: 'https://www.facebook.com/marketplace/item/123/',
          name: 'iPhone 13 128GB',
        },
      ],
      true,
    );

    expect(gateway.requests).toHaveLength(0);
    expect(result.badges).toHaveLength(0);
    expect(result.unpainted).toHaveLength(0);
    expect(result.panel.status).toBe('need-query');
    expect(result.panel.notice).toMatch(/query/i);
    expect(result.panel.scanned).toBe(0);
  });

  it('sends nothing and points at the options page when the key is missing', async () => {
    const gateway = new ScriptedGateway(() => ok());
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'iPhone 13' },
      [
        {
          href: 'https://www.facebook.com/marketplace/item/123/',
          name: 'iPhone 13 128GB',
        },
      ],
      false,
    );

    expect(gateway.requests).toHaveLength(0);
    expect(result.badges).toHaveLength(0);
    expect(result.unpainted).toHaveLength(0);
    expect(result.panel.status).toBe('need-key');
    expect(result.panel.notice).toMatch(/options page/i);
    expect(result.panel.scanned).toBe(1);
  });

  it('scores one wave with fit and dealbreaker questions per listing', async () => {
    const gateway = new ScriptedGateway(
      answersFor({
        '101': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 },
        '202': { fit: 0.3, confidence: 0.9, dealbreaker: 0.1 },
      }),
    );
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'iPhone 13' },
      [
        {
          href: 'https://www.facebook.com/marketplace/item/101/',
          name: 'iPhone 13 128GB, Palermo',
        },
        {
          href: 'https://www.facebook.com/marketplace/item/202/',
          name: 'Moto G charger cable',
        },
      ],
      true,
    );

    expect(gateway.requests).toHaveLength(1);
    const request = gateway.requests[0]!;
    expect(request.model).toBe('jev-1.13');
    expect(request.state.query).toBe('iPhone 13');
    expect(request.state.note).toBe('');
    expect(request.state.listings).toEqual([
      { id: '101', title: 'iPhone 13 128GB, Palermo' },
      { id: '202', title: 'Moto G charger cable' },
    ]);

    expect(request.questions).toHaveLength(4);
    for (const id of ['101', '202']) {
      const named = request.questions.filter((q) => q.name.includes(id));
      expect(named.map((q) => q.kind).sort()).toEqual(['noul', 'score']);
      const fit = named.find((q) => q.kind === 'score')!;
      expect(fit.kind).toBe('score');
      if (fit.kind === 'score') {
        expect(fit.instruction).toMatch(/how well this listing matches/i);
        expect(fit.instruction).toMatch(/judge the product/i);
        expect(fit.instruction).toMatch(/bargain/i);
        expect(fit.levels).toHaveLength(4);
        expect(fit.levels[0]).toMatch(/different product/i);
        expect(fit.levels[1]).toMatch(/wrong model/i);
        expect(fit.levels[2]).toMatch(/nothing in the text conflicts with the note/i);
        expect(fit.levels[3]).toMatch(/clear match/i);
      }
      const dealbreaker = named.find((q) => q.kind === 'noul')!;
      expect(dealbreaker.kind).toBe('noul');
      if (dealbreaker.kind === 'noul') {
        expect(dealbreaker.instruction).toMatch(/concrete reason to reject/i);
        expect(dealbreaker.instruction).toMatch(/broken/i);
        expect(dealbreaker.instruction).toMatch(/for parts/i);
        expect(dealbreaker.instruction).toMatch(/replica/i);
        expect(dealbreaker.instruction).toMatch(/scam/i);
        expect(dealbreaker.instruction).toMatch(/contradicts the request/i);
        expect(dealbreaker.instruction).toMatch(/short title with no red flag/i);
        expect(dealbreaker.trueCriterion).toMatch(/concrete reason to reject/i);
        expect(dealbreaker.falseCriterion).toMatch(/no concrete reject reason/i);
      }
    }

    expect(result.badges).toEqual([
      { id: '101', text: 'MATCH 2.6', tone: 'match' },
      { id: '202', text: 'SKIP 0.3', tone: 'skip' },
    ]);
    expect(result.unpainted).toEqual([]);
    expect(result.panel.status).toBe('ready');
    expect(result.panel.notice).toBeNull();
    expect(result.panel.entries).toEqual([
      { id: '101', title: 'iPhone 13 128GB, Palermo', verdict: 'MATCH', fit: 2.6 },
      { id: '202', title: 'Moto G charger cable', verdict: 'SKIP', fit: 0.3 },
    ]);
    expect(result.panel.scanned).toBe(2);
    expect(result.panel.kept).toBe(1);
    expect(result.panel.skipped).toBe(1);
    expect(result.panel.review).toBe(0);
    expect(result.panel.lastMs).toBe(120);
    expect(result.panel.totalCost).toBeCloseTo(0.001, 6);
    expect(result.panel.error).toBeNull();
  });

  it('applies the verdict rules in order at every boundary', async () => {
    const scripted: Record<string, ScriptedVerdict> = {
      //                     fit,   conf,  foul  → verdict
      '11': { fit: 2.9, confidence: 0.9, dealbreaker: 0.85 }, // SKIP: foul beats fit
      '22': { fit: 2.5, confidence: 0.9, dealbreaker: 0.8 }, // SKIP: 0.8 is a reject
      '33': { fit: 2.5, confidence: 0.9, dealbreaker: 0.79 }, // MATCH: just below
      '44': { fit: 3.0, confidence: 0.44, dealbreaker: 0.0 }, // REVIEW: unsure read
      '55': { fit: 2.0, confidence: 0.45, dealbreaker: 0.0 }, // MATCH: edges inclusive
      '66': { fit: 1.99, confidence: 0.9, dealbreaker: 0.0 }, // REVIEW: weak band
      '77': { fit: 1.0, confidence: 0.9, dealbreaker: 0.0 }, // REVIEW: band floor
      '88': { fit: 0.99, confidence: 0.9, dealbreaker: 0.0 }, // SKIP: clear miss
      '99': { fit: 2.6, confidence: 0.9, dealbreaker: 0.6 }, // MATCH: mild flag
      '101': { fit: 0.5, confidence: 0.3, dealbreaker: 0.9 }, // SKIP: foul before unsure
    };
    const gateway = new ScriptedGateway(answersFor(scripted));
    const session = new MarketplaceSession(gateway);
    const ids = Object.keys(scripted);

    const result = await session.judgeWave(
      { query: 'bike' },
      ids.map((id) => ({
        href: `https://www.facebook.com/marketplace/item/${id}/`,
        name: `listing ${id}`,
      })),
      true,
    );

    expect(result.badges.map((badge) => badge.text)).toEqual([
      'SKIP 2.9',
      'SKIP 2.5',
      'MATCH 2.5',
      'REVIEW 3.0',
      'MATCH 2.0',
      'REVIEW 2.0',
      'REVIEW 1.0',
      'SKIP 1.0',
      'MATCH 2.6',
      'SKIP 0.5',
    ]);
    expect(result.panel.entries.map((entry) => entry.id)).toEqual([
      '99',
      '33',
      '55',
      '44',
      '66',
      '77',
      '11',
      '22',
      '88',
      '101',
    ]);
    expect(result.panel.kept).toBe(3);
    expect(result.panel.review).toBe(3);
    expect(result.panel.skipped).toBe(4);
  });

  it('cuts a wave past 12 listings into one request per chunk', async () => {
    const ids = Array.from({ length: 13 }, (_, index) => `${200 + index}`);
    const scripted: Record<string, ScriptedVerdict> = Object.fromEntries(
      ids.map((id) => [id, { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 }]),
    );
    let calls = 0;
    const gateway = new ScriptedGateway((request) => {
      calls += 1;
      return answersFor(scripted, 100 + calls * 10, 0.001 * calls)(request);
    });
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'lamp' },
      ids.map((id) => ({
        href: `https://www.facebook.com/marketplace/item/${id}/`,
        name: `listing ${id}`,
      })),
      true,
    );

    expect(gateway.requests).toHaveLength(2);
    const [first, second] = gateway.requests as [DecisionRequest, DecisionRequest];
    expect(first.model).toBe('jev-1.13');
    expect(first.state.listings.map((listing) => listing.id)).toEqual(ids.slice(0, 12));
    expect(first.questions).toHaveLength(24);
    expect(second.model).toBe('jev-1.13');
    expect(second.state.listings.map((listing) => listing.id)).toEqual(ids.slice(12));
    expect(second.questions).toHaveLength(2);
    expect(result.badges).toHaveLength(13);
    expect(result.unpainted).toEqual([]);
    expect(result.panel.scanned).toBe(13);
    expect(result.panel.kept).toBe(13);
    expect(result.panel.lastMs).toBe(120);
    expect(result.panel.totalCost).toBeCloseTo(0.003, 6);
  });

  it('sends repeated tiles of one item once and shares the judgment', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '123': { fit: 2.8, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'iPhone' },
      [
        {
          href: 'https://www.facebook.com/marketplace/item/123/',
          name: 'iPhone 13 128GB',
        },
        {
          href: 'https://www.facebook.com/marketplace/item/123/?ref=grid',
          name: 'iPhone 13 128GB',
        },
      ],
      true,
    );

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.state.listings).toEqual([
      { id: '123', title: 'iPhone 13 128GB' },
    ]);
    expect(gateway.requests[0]!.questions).toHaveLength(2);
    expect(result.badges).toEqual([{ id: '123', text: 'MATCH 2.8', tone: 'match' }]);
    expect(result.panel.entries).toHaveLength(1);
    expect(result.panel.scanned).toBe(2);
    expect(result.panel.kept).toBe(1);
  });

  it('ignores snapshots that are not marketplace items', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '123': { fit: 2.8, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'iPhone' },
      [
        { href: 'https://www.facebook.com/marketplace/', name: 'Marketplace' },
        {
          href: 'https://www.facebook.com/marketplace/item/123/',
          name: 'iPhone 13 128GB',
        },
      ],
      true,
    );

    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.state.listings).toEqual([
      { id: '123', title: 'iPhone 13 128GB' },
    ]);
    expect(result.panel.scanned).toBe(1);
    expect(result.panel.kept).toBe(1);
  });

  it('leaves a failed chunk unpainted without retrying', async () => {
    const ids = Array.from({ length: 13 }, (_, index) => `${300 + index}`);
    const scripted: Record<string, ScriptedVerdict> = Object.fromEntries(
      ids.map((id) => [id, { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 }]),
    );
    let failedOnce = false;
    const gateway = new ScriptedGateway((request) => {
      if (request.state.listings.length === 1 && !failedOnce) {
        failedOnce = true;
        return { ok: false, error: 'Jev timed out.', ms: 90 };
      }
      return answersFor(scripted, 110, 0.001)(request);
    });
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'lamp' },
      ids.map((id) => ({
        href: `https://www.facebook.com/marketplace/item/${id}/`,
        name: `listing ${id}`,
      })),
      true,
    );

    expect(gateway.requests).toHaveLength(2);
    expect(result.badges).toHaveLength(12);
    expect(result.unpainted).toEqual(['312']);
    expect(result.panel.status).toBe('ready');
    expect(result.panel.error).toBe('Jev timed out.');
    expect(result.panel.entries).toHaveLength(12);
    expect(result.panel.scanned).toBe(13);
    expect(result.panel.kept).toBe(12);
    expect(result.panel.lastMs).toBe(90);
    expect(result.panel.totalCost).toBeCloseTo(0.001, 6);

    const retry = await session.judgeWave(
      { query: 'lamp' },
      [
        {
          href: 'https://www.facebook.com/marketplace/item/312/',
          name: 'listing 312',
        },
      ],
      true,
    );
    expect(gateway.requests).toHaveLength(3);
    expect(retry.unpainted).toEqual([]);
    expect(retry.panel.error).toBeNull();
    expect(retry.panel.kept).toBe(13);
  });

  it('previews the panel without sending or counting', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '123': { fit: 2.8, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);

    expect(session.preview({ query: '' }, true).status).toBe('need-query');
    expect(session.preview({ query: 'iPhone' }, false).status).toBe('need-key');
    expect(session.preview({ query: '  ' }, false).status).toBe('need-query');

    const judged = await session.judgeWave(
      { query: 'iPhone' },
      [
        {
          href: 'https://www.facebook.com/marketplace/item/123/',
          name: 'iPhone 13 128GB',
        },
      ],
      true,
    );
    expect(session.preview({ query: 'iPhone' }, true)).toEqual(judged.panel);
    expect(gateway.requests).toHaveLength(1);
    expect(session.preview({ query: 'iPhone' }, true).scanned).toBe(1);
  });

  it('leaves listings with omitted answers unpainted and names them', async () => {
    const gateway = new ScriptedGateway(() => ({
      ok: true,
      answers: {},
      ms: 50,
      cost: 0.0005,
    }));
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'lamp' },
      [
        {
          href: 'https://www.facebook.com/marketplace/item/404/',
          name: 'listing 404',
        },
      ],
      true,
    );

    expect(gateway.requests).toHaveLength(1);
    expect(result.badges).toEqual([]);
    expect(result.unpainted).toEqual(['404']);
    expect(result.panel.error).toMatch(/404/);
    expect(result.panel.entries).toHaveLength(0);
    expect(result.panel.scanned).toBe(1);
    expect(result.panel.totalCost).toBeCloseTo(0.0005, 6);
  });
});
