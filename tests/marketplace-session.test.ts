import { describe, expect, it } from 'vitest';
import { MarketplaceSession } from '../src/session/marketplace';
import type {
  AnswerValue,
  Brief,
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
      { id: '101', title: 'iPhone 13 128GB', price: null, currency: null, place: 'Palermo' },
      { id: '202', title: 'Moto G charger cable', price: null, currency: null, place: '' },
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
      { id: '101', title: 'iPhone 13 128GB', verdict: 'MATCH', fit: 2.6, reason: null },
      { id: '202', title: 'Moto G charger cable', verdict: 'SKIP', fit: 0.3, reason: null },
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
      { id: '123', title: 'iPhone 13 128GB', price: null, currency: null, place: '' },
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
      { id: '123', title: 'iPhone 13 128GB', price: null, currency: null, place: '' },
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

describe('marketplace session hard limits (#3)', () => {
  const tile = (id: string, name: string) => ({
    href: `https://www.facebook.com/marketplace/item/${id}/`,
    name,
  });

  it('keeps the spec tile at max 300000 and rejects it at max 200000', async () => {
    const name = 'iPhone 13 128GB, $ 250.000, Palermo';

    const survivorGateway = new ScriptedGateway(
      answersFor({ '101': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 } }),
    );
    const survivorSession = new MarketplaceSession(survivorGateway);
    const survivor = await survivorSession.judgeWave(
      { query: 'iPhone 13', maxPrice: 300000, currency: 'ARS' },
      [tile('101', name)],
      true,
    );
    expect(survivorGateway.requests).toHaveLength(1);
    expect(survivorGateway.requests[0]!.state.listings).toEqual([
      { id: '101', title: 'iPhone 13 128GB', price: 250000, currency: 'ARS', place: 'Palermo' },
    ]);
    expect(survivor.badges).toEqual([{ id: '101', text: 'MATCH 2.6', tone: 'match' }]);

    const rejectGateway = new ScriptedGateway(() => ok());
    const rejectSession = new MarketplaceSession(rejectGateway);
    const rejected = await rejectSession.judgeWave(
      { query: 'iPhone 13', maxPrice: 200000, currency: 'ARS' },
      [tile('101', name)],
      true,
    );
    expect(rejectGateway.requests).toHaveLength(0);
    expect(rejected.badges).toEqual([{ id: '101', text: 'SKIP price', tone: 'skip' }]);
    expect(rejected.unpainted).toEqual([]);
    expect(rejected.panel.entries).toEqual([
      { id: '101', title: 'iPhone 13 128GB', verdict: 'SKIP', fit: null, reason: 'price' },
    ]);
    expect(rejected.panel.skipped).toBe(1);
  });

  it('sends a price equal to the max and skips a peso above it', async () => {
    const atMaxGateway = new ScriptedGateway(
      answersFor({ '11': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const atMax = new MarketplaceSession(atMaxGateway);
    const kept = await atMax.judgeWave(
      { query: 'bike', maxPrice: 250000, currency: 'ARS' },
      [tile('11', 'Bike, $ 250.000, Palermo')],
      true,
    );
    expect(atMaxGateway.requests).toHaveLength(1);
    expect(kept.badges).toEqual([{ id: '11', text: 'MATCH 2.5', tone: 'match' }]);

    const overGateway = new ScriptedGateway(() => ok());
    const over = new MarketplaceSession(overGateway);
    const skipped = await over.judgeWave(
      { query: 'bike', maxPrice: 249999, currency: 'ARS' },
      [tile('11', 'Bike, $ 250.000, Palermo')],
      true,
    );
    expect(overGateway.requests).toHaveLength(0);
    expect(skipped.badges).toEqual([{ id: '11', text: 'SKIP price', tone: 'skip' }]);
  });

  it('judges a range on its lower amount', async () => {
    const underGateway = new ScriptedGateway(
      answersFor({ '21': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const under = new MarketplaceSession(underGateway);
    const kept = await under.judgeWave(
      { query: 'lamp', maxPrice: 150, currency: 'ARS' },
      [tile('21', 'Lamp, $ 100 - $ 200, Palermo')],
      true,
    );
    expect(underGateway.requests).toHaveLength(1);
    expect(underGateway.requests[0]!.state.listings[0]).toMatchObject({ price: 100 });

    const overGateway = new ScriptedGateway(() => ok());
    const over = new MarketplaceSession(overGateway);
    const skipped = await over.judgeWave(
      { query: 'lamp', maxPrice: 50, currency: 'ARS' },
      [tile('21', 'Lamp, $ 100 - $ 200, Palermo')],
      true,
    );
    expect(overGateway.requests).toHaveLength(0);
    expect(skipped.badges).toEqual([{ id: '21', text: 'SKIP price', tone: 'skip' }]);

    const barePartnerGateway = new ScriptedGateway(
      answersFor({ '22': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const barePartner = new MarketplaceSession(barePartnerGateway);
    await barePartner.judgeWave(
      { query: 'lamp', maxPrice: 150, currency: 'ARS' },
      [tile('22', 'Lamp, $100-200, Palermo')],
      true,
    );
    expect(barePartnerGateway.requests).toHaveLength(1);
    expect(barePartnerGateway.requests[0]!.state.listings[0]).toMatchObject({
      price: 100,
      title: 'Lamp',
      place: 'Palermo',
    });
  });

  it('reads a trailing short separator as a decimal', async () => {
    const overGateway = new ScriptedGateway(() => ok());
    const over = new MarketplaceSession(overGateway);
    const skipped = await over.judgeWave(
      { query: 'cable', maxPrice: 10, currency: 'ARS' },
      [tile('31', 'Cable, $ 10.50, Palermo')],
      true,
    );
    expect(overGateway.requests).toHaveLength(0);
    expect(skipped.badges).toEqual([{ id: '31', text: 'SKIP price', tone: 'skip' }]);

    const underGateway = new ScriptedGateway(
      answersFor({ '32': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const under = new MarketplaceSession(underGateway);
    await under.judgeWave(
      { query: 'lamp', maxPrice: 1235, currency: 'ARS' },
      [tile('32', 'Lamp, $ 1.234,56, Palermo')],
      true,
    );
    expect(underGateway.requests).toHaveLength(1);
    expect(underGateway.requests[0]!.state.listings[0]).toMatchObject({ price: 1234.56 });
  });

  it('passes Free and Gratis as price 0 in the brief currency', async () => {
    for (const word of ['Free', 'Gratis']) {
      const gateway = new ScriptedGateway(
        answersFor({ '41': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
      );
      const session = new MarketplaceSession(gateway);
      const result = await session.judgeWave(
        { query: 'bike', maxPrice: 0, currency: 'ARS' },
        [tile('41', `Bike, ${word}, Palermo`)],
        true,
      );
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]!.state.listings).toEqual([
        { id: '41', title: 'Bike', price: 0, currency: 'ARS', place: 'Palermo' },
      ]);
      expect(result.badges).toEqual([{ id: '41', text: 'MATCH 2.5', tone: 'match' }]);
    }
  });

  it('rejects a missing price with a max and sends it without one', async () => {
    const cappedGateway = new ScriptedGateway(() => ok());
    const capped = new MarketplaceSession(cappedGateway);
    const skipped = await capped.judgeWave(
      { query: 'bike', maxPrice: 100, currency: 'ARS' },
      [tile('51', 'Bike, contact for price, Palermo')],
      true,
    );
    expect(cappedGateway.requests).toHaveLength(0);
    expect(skipped.badges).toEqual([{ id: '51', text: 'SKIP no price', tone: 'skip' }]);
    expect(skipped.panel.entries).toEqual([
      { id: '51', title: 'Bike, contact for price', verdict: 'SKIP', fit: null, reason: 'no price' },
    ]);

    const openGateway = new ScriptedGateway(
      answersFor({ '51': { fit: 2.4, confidence: 0.8, dealbreaker: 0.1 } }),
    );
    const open = new MarketplaceSession(openGateway);
    const sent = await open.judgeWave(
      { query: 'bike', currency: 'ARS' },
      [tile('51', 'Bike, contact for price, Palermo')],
      true,
    );
    expect(openGateway.requests).toHaveLength(1);
    expect(openGateway.requests[0]!.state.listings).toEqual([
      { id: '51', title: 'Bike, contact for price', price: null, currency: null, place: 'Palermo' },
    ]);
    expect(sent.badges).toEqual([{ id: '51', text: 'MATCH 2.4', tone: 'match' }]);
  });

  it('reads a bare $ as the brief currency', async () => {
    for (const currency of ['ARS', 'USD'] as const) {
      const gateway = new ScriptedGateway(
        answersFor({ '61': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
      );
      const session = new MarketplaceSession(gateway);
      await session.judgeWave(
        { query: 'lamp', maxPrice: 200, currency },
        [tile('61', 'Lamp, $ 100, Palermo')],
        true,
      );
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]!.state.listings[0]).toMatchObject({
        price: 100,
        currency,
      });
    }
  });

  it('reads US$, U$S, and USD as dollars and ARS as pesos', async () => {
    for (const marker of ['US$', 'U$S', 'USD']) {
      const gateway = new ScriptedGateway(() => ok());
      const session = new MarketplaceSession(gateway);
      const result = await session.judgeWave(
        { query: 'bike', maxPrice: 300000, currency: 'ARS' },
        [tile('71', `Bike, ${marker} 200, Palermo`)],
        true,
      );
      expect(gateway.requests).toHaveLength(0);
      expect(result.badges).toEqual([{ id: '71', text: 'SKIP currency', tone: 'skip' }]);
    }

    const arsGateway = new ScriptedGateway(
      answersFor({ '72': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const arsSession = new MarketplaceSession(arsGateway);
    await arsSession.judgeWave(
      { query: 'bike', maxPrice: 300, currency: 'ARS' },
      [tile('72', 'Bike, ARS 200, Palermo')],
      true,
    );
    expect(arsGateway.requests).toHaveLength(1);
    expect(arsGateway.requests[0]!.state.listings[0]).toMatchObject({
      price: 200,
      currency: 'ARS',
    });

    const usdGateway = new ScriptedGateway(
      answersFor({ '73': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const usdSession = new MarketplaceSession(usdGateway);
    await usdSession.judgeWave(
      { query: 'bike', maxPrice: 300, currency: 'USD' },
      [tile('73', 'Bike, US$ 200, Palermo')],
      true,
    );
    expect(usdGateway.requests).toHaveLength(1);
    expect(usdGateway.requests[0]!.state.listings[0]).toMatchObject({
      price: 200,
      currency: 'USD',
    });

    const mismatchGateway = new ScriptedGateway(() => ok());
    const mismatch = new MarketplaceSession(mismatchGateway);
    const result = await mismatch.judgeWave(
      { query: 'bike', maxPrice: 300, currency: 'USD' },
      [tile('74', 'Bike, ARS 200, Palermo')],
      true,
    );
    expect(mismatchGateway.requests).toHaveLength(0);
    expect(result.badges).toEqual([{ id: '74', text: 'SKIP currency', tone: 'skip' }]);
  });

  it('rejects any other recognized currency with no exchange rate', async () => {
    for (const [currency, name] of [
      ['ARS', 'Bike, € 100, Palermo'],
      ['USD', 'Bike, R$ 100, Palermo'],
      ['ARS', 'Bike, 100 EUR, Palermo'],
    ] as const) {
      const gateway = new ScriptedGateway(() => ok());
      const session = new MarketplaceSession(gateway);
      const result = await session.judgeWave(
        { query: 'bike', currency },
        [tile('81', name)],
        true,
      );
      expect(gateway.requests).toHaveLength(0);
      expect(result.badges).toEqual([{ id: '81', text: 'SKIP currency', tone: 'skip' }]);
    }
  });

  it('matches places as a case-insensitive OR', async () => {
    const gateway = new ScriptedGateway(
      answersFor({
        '91': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
        '92': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
      }),
    );
    const session = new MarketplaceSession(gateway);
    const result = await session.judgeWave(
      { query: 'bike', places: ['palermo', 'Belgrano'] },
      [
        tile('91', 'Bike, $ 100, Palermo'),
        tile('92', 'Bike, $ 100, BELGRANO'),
        tile('93', 'Bike, $ 100, Recoleta'),
      ],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.state.listings.map((listing) => listing.id)).toEqual(['91', '92']);
    expect(result.badges).toEqual([
      { id: '93', text: 'SKIP location', tone: 'skip' },
      { id: '91', text: 'MATCH 2.5', tone: 'match' },
      { id: '92', text: 'MATCH 2.5', tone: 'match' },
    ]);
  });

  it('leaves place unfiltered with an empty place list', async () => {
    const gateway = new ScriptedGateway(
      answersFor({
        '94': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
        '95': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
      }),
    );
    const session = new MarketplaceSession(gateway);
    const result = await session.judgeWave(
      { query: 'bike', places: [] },
      [tile('94', 'Bike, $ 100, Recoleta'), tile('95', 'Bike, $ 100')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(result.badges).toHaveLength(2);
    expect(result.badges.map((badge) => badge.text)).toEqual(['MATCH 2.5', 'MATCH 2.5']);
  });

  it('fails a listing with no parsed place when places are set', async () => {
    const gateway = new ScriptedGateway(() => ok());
    const session = new MarketplaceSession(gateway);
    const result = await session.judgeWave(
      { query: 'bike', places: ['Palermo'] },
      [tile('96', 'Bike, $ 100')],
      true,
    );
    expect(gateway.requests).toHaveLength(0);
    expect(result.badges).toEqual([{ id: '96', text: 'SKIP location', tone: 'skip' }]);
    expect(result.panel.entries).toEqual([
      { id: '96', title: 'Bike', verdict: 'SKIP', fit: null, reason: 'location' },
    ]);
  });

  it('splits title and place after price and listing-id removal', async () => {
    const gateway = new ScriptedGateway(
      answersFor({
        '97': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
        '98': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
      }),
    );
    const session = new MarketplaceSession(gateway);
    await session.judgeWave(
      { query: 'bike' },
      [
        tile('97', 'Bike, mountain, $ 100, Palermo, Listing ID 999'),
        tile('98', 'Moto G charger cable'),
      ],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.state.listings).toEqual([
      { id: '97', title: 'Bike, mountain', price: 100, currency: 'ARS', place: 'Palermo' },
      { id: '98', title: 'Moto G charger cable', price: null, currency: null, place: '' },
    ]);
  });

  it('keeps local SKIP listings out of the request entirely', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '112': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 } }),
    );
    const session = new MarketplaceSession(gateway);
    const result = await session.judgeWave(
      { query: 'iPhone', maxPrice: 200000, currency: 'ARS', places: ['Palermo'] },
      [
        tile('111', 'iPhone 13 128GB, $ 250.000, Palermo'),
        tile('112', 'iPhone 13 128GB, $ 150.000, Palermo'),
        tile('113', 'iPhone 13 128GB, US$ 200, Palermo'),
        tile('114', 'iPhone 13 128GB, $ 150.000, Recoleta'),
      ],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    const request = gateway.requests[0]!;
    expect(request.state.listings.map((listing) => listing.id)).toEqual(['112']);
    expect(request.questions).toHaveLength(2);
    expect(request.questions.every((question) => question.name.includes('112'))).toBe(true);
    expect(result.badges).toEqual([
      { id: '111', text: 'SKIP price', tone: 'skip' },
      { id: '113', text: 'SKIP currency', tone: 'skip' },
      { id: '114', text: 'SKIP location', tone: 'skip' },
      { id: '112', text: 'MATCH 2.6', tone: 'match' },
    ]);
    expect(result.unpainted).toEqual([]);
    expect(result.panel.scanned).toBe(4);
    expect(result.panel.kept).toBe(1);
    expect(result.panel.skipped).toBe(3);
  });

  it('paints local SKIP with a missing key while survivors stay unpainted', async () => {
    const gateway = new ScriptedGateway(() => ok());
    const session = new MarketplaceSession(gateway);
    const result = await session.judgeWave(
      { query: 'iPhone', maxPrice: 200000, currency: 'ARS' },
      [
        tile('121', 'iPhone 13 128GB, $ 250.000, Palermo'),
        tile('122', 'iPhone 13 128GB, $ 150.000, Palermo'),
      ],
      false,
    );
    expect(gateway.requests).toHaveLength(0);
    expect(result.badges).toEqual([{ id: '121', text: 'SKIP price', tone: 'skip' }]);
    expect(result.unpainted).toEqual([]);
    expect(result.panel.status).toBe('need-key');
    expect(result.panel.notice).toMatch(/options page/i);
    expect(result.panel.entries).toEqual([
      { id: '121', title: 'iPhone 13 128GB', verdict: 'SKIP', fit: null, reason: 'price' },
    ]);
    expect(result.panel.scanned).toBe(2);
    expect(result.panel.skipped).toBe(1);
  });

  it('sends survivors with the note, price, currency, and place', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '131': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 } }),
    );
    const session = new MarketplaceSession(gateway);
    await session.judgeWave(
      { query: 'iPhone', currency: 'ARS', note: 'Must be unlocked, no cracks.' },
      [tile('131', 'iPhone 13 128GB, $ 250.000, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    const request = gateway.requests[0]!;
    expect(request.state.query).toBe('iPhone');
    expect(request.state.note).toBe('Must be unlocked, no cracks.');
    expect(request.state.listings).toEqual([
      { id: '131', title: 'iPhone 13 128GB', price: 250000, currency: 'ARS', place: 'Palermo' },
    ]);

    const emptyNoteGateway = new ScriptedGateway(
      answersFor({ '132': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 } }),
    );
    const emptyNote = new MarketplaceSession(emptyNoteGateway);
    await emptyNote.judgeWave(
      { query: 'iPhone', currency: 'ARS' },
      [tile('132', 'iPhone 13 128GB, $ 250.000, Palermo')],
      true,
    );
    expect(emptyNoteGateway.requests[0]!.state.note).toBe('');
  });

  it('lets an explicit price beat a stray free in the title', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '151': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);
    await session.judgeWave(
      { query: 'helmet', maxPrice: 200, currency: 'ARS' },
      [tile('151', 'Helmet, $ 100, free shipping, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.state.listings).toEqual([
      { id: '151', title: 'Helmet, free shipping', price: 100, currency: 'ARS', place: 'Palermo' },
    ]);
  });

  it('keeps a place with a trailing postcode intact', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '152': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);
    await session.judgeWave(
      { query: 'bike', places: ['madrid'] },
      [tile('152', 'Bike, $ 100, Madrid 28004')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.state.listings).toEqual([
      { id: '152', title: 'Bike', price: 100, currency: 'ARS', place: 'Madrid 28004' },
    ]);
  });

  it('treats the product query as model context, not a title word match', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '141': { fit: 0.3, confidence: 0.9, dealbreaker: 0.1 } }),
    );
    const session = new MarketplaceSession(gateway);
    const result = await session.judgeWave(
      { query: 'iPhone 13' },
      [tile('141', 'Samsung Galaxy S22, $ 100, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.state.query).toBe('iPhone 13');
    expect(result.badges).toEqual([{ id: '141', text: 'SKIP 0.3', tone: 'skip' }]);
  });
});

describe('marketplace session score cache (#4)', () => {
  const tile = (id: string, name: string) => ({
    href: `https://www.facebook.com/marketplace/item/${id}/`,
    name,
  });

  it('reuses grid judgments when a tile comes back and keeps off-screen listings in the panel', async () => {
    const gateway = new ScriptedGateway(
      answersFor({
        '101': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 },
        '202': { fit: 0.3, confidence: 0.9, dealbreaker: 0.1 },
      }),
    );
    const session = new MarketplaceSession(gateway);
    const brief = { query: 'iPhone 13' };
    const a = tile('101', 'iPhone 13 128GB, $ 250.000, Palermo');
    const b = tile('202', 'Moto G charger cable');

    const first = await session.judgeWave(brief, [a, b], true);
    expect(gateway.requests).toHaveLength(1);
    expect(first.badges).toEqual([
      { id: '101', text: 'MATCH 2.6', tone: 'match' },
      { id: '202', text: 'SKIP 0.3', tone: 'skip' },
    ]);

    // Tile 202 scrolls away: no new call, and the panel keeps it.
    const second = await session.judgeWave(brief, [a], true);
    expect(gateway.requests).toHaveLength(1);
    expect(second.badges).toEqual([{ id: '101', text: 'MATCH 2.6', tone: 'match' }]);
    expect(second.unpainted).toEqual([]);
    expect(second.panel.entries.map((entry) => entry.id)).toEqual(['101', '202']);
    expect(second.panel.scanned).toBe(3);
    expect(second.panel.lastMs).toBe(first.panel.lastMs);
    expect(second.panel.totalCost).toBeCloseTo(first.panel.totalCost, 6);

    // Tile 202 scrolls back: repainted from the cache, still no new call.
    const third = await session.judgeWave(brief, [a, b], true);
    expect(gateway.requests).toHaveLength(1);
    expect(third.badges).toEqual(first.badges);
    expect(third.panel.entries.map((entry) => entry.id)).toEqual(['101', '202']);
  });

  it('scores the same item again when its price changes', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '301': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 } }),
    );
    const session = new MarketplaceSession(gateway);
    const brief = { query: 'iPhone 13', maxPrice: 300000, currency: 'ARS' as const };

    const first = await session.judgeWave(
      brief,
      [tile('301', 'iPhone 13 128GB, $ 250.000, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(first.badges).toEqual([{ id: '301', text: 'MATCH 2.6', tone: 'match' }]);

    const second = await session.judgeWave(
      brief,
      [tile('301', 'iPhone 13 128GB, $ 260.000, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]!.state.listings).toEqual([
      { id: '301', title: 'iPhone 13 128GB', price: 260000, currency: 'ARS', place: 'Palermo' },
    ]);
    expect(second.badges).toEqual([{ id: '301', text: 'MATCH 2.6', tone: 'match' }]);
  });

  it('rejects the same item locally when only its currency changes', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '302': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 } }),
    );
    const session = new MarketplaceSession(gateway);
    const brief = { query: 'iPhone 13', maxPrice: 300000, currency: 'ARS' as const };

    const first = await session.judgeWave(
      brief,
      [tile('302', 'iPhone 13 128GB, $ 250.000, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(first.badges).toEqual([{ id: '302', text: 'MATCH 2.6', tone: 'match' }]);

    // Same digits, now dollars against a peso brief: the stored MATCH no
    // longer applies, and the tile is a local SKIP without a new call.
    const second = await session.judgeWave(
      brief,
      [tile('302', 'iPhone 13 128GB, US$ 250.000, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(second.badges).toEqual([{ id: '302', text: 'SKIP currency', tone: 'skip' }]);
    expect(second.panel.entries).toEqual([
      { id: '302', title: 'iPhone 13 128GB', verdict: 'SKIP', fit: null, reason: 'currency' },
    ]);
  });

  it('clears every stored judgment and rescores the screen when the query changes', async () => {
    let calls = 0;
    const gateway = new ScriptedGateway((request) => {
      calls += 1;
      const rescore = calls > 1;
      return answersFor({
        '401': rescore
          ? { fit: 0.2, confidence: 0.9, dealbreaker: 0.1 }
          : { fit: 2.8, confidence: 0.9, dealbreaker: 0.0 },
        '402': { fit: 2.7, confidence: 0.9, dealbreaker: 0.0 },
      })(request);
    });
    const session = new MarketplaceSession(gateway);

    const first = await session.judgeWave(
      { query: 'iPhone 13' },
      [tile('401', 'iPhone 13 128GB, Palermo'), tile('402', 'iPhone 13 mini, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(1);
    expect(first.panel.entries.map((entry) => entry.id)).toEqual(['401', '402']);

    // A new query drops the stored MATCH for 401 and the off-screen 402,
    // then judges what is on screen again under the new brief.
    const second = await session.judgeWave(
      { query: 'iPhone 14' },
      [tile('401', 'iPhone 13 128GB, Palermo')],
      true,
    );
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]!.state.query).toBe('iPhone 14');
    expect(gateway.requests[1]!.state.listings.map((listing) => listing.id)).toEqual(['401']);
    expect(second.badges).toEqual([{ id: '401', text: 'SKIP 0.2', tone: 'skip' }]);
    expect(second.panel.entries).toEqual([
      { id: '401', title: 'iPhone 13 128GB', verdict: 'SKIP', fit: 0.2, reason: null },
    ]);
  });

  it.each([
    { field: 'query', edit: { query: 'ebike' }, requests: 2, badge: 'MATCH 2.5' },
    { field: 'max price', edit: { maxPrice: 600 }, requests: 2, badge: 'MATCH 2.5' },
    { field: 'currency', edit: { currency: 'USD' }, requests: 2, badge: 'MATCH 2.5' },
    { field: 'places', edit: { places: ['Recoleta'] }, requests: 1, badge: 'SKIP location' },
    { field: 'note', edit: { note: 'must be red' }, requests: 2, badge: 'MATCH 2.5' },
  ] as Array<{ field: string; edit: Partial<Brief>; requests: number; badge: string }>)('drops the stored judgment when the brief $field changes', async ({ edit, requests, badge }) => {
    const gateway = new ScriptedGateway(
      answersFor({ '451': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);
    const base = {
      query: 'bike',
      maxPrice: 500,
      currency: 'ARS' as const,
      places: ['Palermo'],
      note: 'no cracks',
    };
    const snapshot = tile('451', 'Bike, $ 100, Palermo');

    const first = await session.judgeWave(base, [snapshot], true);
    expect(gateway.requests).toHaveLength(1);
    expect(first.badges).toEqual([{ id: '451', text: 'MATCH 2.5', tone: 'match' }]);

    const second = await session.judgeWave({ ...base, ...edit }, [snapshot], true);
    expect(gateway.requests).toHaveLength(requests);
    expect(second.badges).toEqual([{ id: '451', text: badge, tone: badge.startsWith('MATCH') ? 'match' : 'skip' }]);
  });

  it('keeps the cache when the brief is rebuilt with the same values', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '452': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);
    const brief = {
      query: 'bike',
      maxPrice: 500,
      currency: 'ARS' as const,
      places: ['Palermo'],
      note: 'no cracks',
    };
    const snapshot = tile('452', 'Bike, $ 100, Palermo');

    await session.judgeWave(brief, [snapshot], true);
    // A new object with equal values (as the stores deliver) is still a hit.
    const second = await session.judgeWave({ ...brief, places: [...brief.places] }, [snapshot], true);
    expect(gateway.requests).toHaveLength(1);
    expect(second.badges).toEqual([{ id: '452', text: 'MATCH 2.5', tone: 'match' }]);
  });

  it('treats any brief-field edit, however small, as a new brief', async () => {
    const gateway = new ScriptedGateway(
      answersFor({ '453': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 } }),
    );
    const session = new MarketplaceSession(gateway);
    const snapshot = tile('453', 'Bike, $ 100, Palermo');

    await session.judgeWave({ query: 'bike' }, [snapshot], true);
    // A trailing space is still an edit: the stored judgment drops and the
    // tile is scored again.
    await session.judgeWave({ query: 'bike ' }, [snapshot], true);
    expect(gateway.requests).toHaveLength(2);
  });

  it('never sends local SKIP listings on a brief-edit rescore and still chunks survivors', async () => {
    const survivorIds = Array.from({ length: 13 }, (_, index) => `${610 + index}`);
    const scripted: Record<string, ScriptedVerdict> = Object.fromEntries(
      survivorIds.map((id) => [id, { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 }]),
    );
    const gateway = new ScriptedGateway(answersFor(scripted));
    const session = new MarketplaceSession(gateway);
    const base = { query: 'lamp', maxPrice: 1000, currency: 'ARS' as const };
    const over = tile('600', 'Lamp, $ 9.999, Palermo');
    const survivors = survivorIds.map((id) => tile(id, `Lamp ${id}, $ 100, Palermo`));

    const first = await session.judgeWave(base, [over, ...survivors], true);
    expect(gateway.requests).toHaveLength(2);
    expect(first.badges[0]).toEqual({ id: '600', text: 'SKIP price', tone: 'skip' });

    const second = await session.judgeWave(
      { ...base, note: 'must be red' },
      [over, ...survivors],
      true,
    );
    expect(gateway.requests).toHaveLength(4);
    for (const request of gateway.requests.slice(2)) {
      expect(request.state.note).toBe('must be red');
      expect(request.state.listings.map((listing) => listing.id)).not.toContain('600');
      expect(request.questions.every((question) => !question.name.includes('600'))).toBe(true);
    }
    expect(gateway.requests[2]!.state.listings).toHaveLength(12);
    expect(gateway.requests[3]!.state.listings).toHaveLength(1);
    expect(second.badges).toHaveLength(14);
    expect(second.badges[0]).toEqual({ id: '600', text: 'SKIP price', tone: 'skip' });
    expect(second.panel.kept).toBe(13);
    expect(second.panel.skipped).toBe(1);
    expect(second.panel.scanned).toBe(28);
  });

  it('reuses stored judgments after a reload in the same browser session', async () => {
    const scripted = {
      '701': { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 },
      '702': { fit: 1.5, confidence: 0.9, dealbreaker: 0.1 },
      '703': { fit: 0.3, confidence: 0.9, dealbreaker: 0.1 },
    };
    const before = new ScriptedGateway(answersFor(scripted));
    const brief = { query: 'iPhone', maxPrice: 200000, currency: 'ARS' as const };
    const snapshots = [
      tile('704', 'iPhone 13 128GB, $ 250.000, Palermo'),
      tile('701', 'iPhone 13 128GB, $ 150.000, Palermo'),
      tile('702', 'iPhone 12, $ 150.000, Palermo'),
      tile('703', 'Charger cable, $ 5.000, Palermo'),
    ];

    const firstSession = new MarketplaceSession(before);
    const first = await firstSession.judgeWave(brief, snapshots, true);
    expect(before.requests).toHaveLength(1);
    expect(first.badges).toEqual([
      { id: '704', text: 'SKIP price', tone: 'skip' },
      { id: '701', text: 'MATCH 2.6', tone: 'match' },
      { id: '702', text: 'REVIEW 1.5', tone: 'review' },
      { id: '703', text: 'SKIP 0.3', tone: 'skip' },
    ]);
    // MATCH, then REVIEW, then SKIP with higher fit first; the local SKIP
    // follows the model SKIP.
    expect(first.panel.entries.map((entry) => entry.id)).toEqual(['701', '702', '703', '704']);

    // A reload rebuilds the session from the browser-session cache: the same
    // tiles repaint with no new call, and the panel keeps every judgment.
    const after = new ScriptedGateway(answersFor(scripted));
    const reloaded = new MarketplaceSession(after, firstSession.snapshot());
    expect(after.requests).toHaveLength(0);

    const preview = reloaded.preview(brief, true);
    expect(preview.entries).toEqual(first.panel.entries);
    expect(preview.totalCost).toBeCloseTo(first.panel.totalCost, 6);
    expect(after.requests).toHaveLength(0);

    const second = await reloaded.judgeWave(brief, snapshots, true);
    expect(after.requests).toHaveLength(0);
    expect(second.badges).toEqual(first.badges);
    expect(second.unpainted).toEqual([]);
    expect(second.panel.entries).toEqual(first.panel.entries);
    expect(second.panel.scanned).toBe(8);
    expect(second.panel.lastMs).toBe(first.panel.lastMs);
    expect(second.panel.totalCost).toBeCloseTo(first.panel.totalCost, 6);
  });
});

describe('marketplace session opened listings (#5)', () => {
  const tile = (id: string, name: string, description?: string) => ({
    href: `https://www.facebook.com/marketplace/item/${id}/`,
    name,
    ...(description === undefined ? {} : { description }),
  });

  // Grid calls score MATCH; opened calls with a description score REVIEW.
  // Different ms/cost per path prove the described verdict replaces the grid
  // badge together with its timing.
  const gridThenDescribed = () =>
    new ScriptedGateway((request) => {
      const listing = request.state.listings[0]!;
      const described = (listing as { description?: unknown }).description !== undefined;
      const scripted = described
        ? { fit: 1.5, confidence: 0.9, dealbreaker: 0.1 }
        : { fit: 2.6, confidence: 0.8, dealbreaker: 0.1 };
      const answers: Record<string, AnswerValue> = {};
      for (const question of request.questions) {
        answers[question.name] =
          question.kind === 'score'
            ? { kind: 'score', value: scripted.fit, confidence: scripted.confidence }
            : { kind: 'noul', probabilityTrue: scripted.dealbreaker };
      }
      return described
        ? { ok: true, answers, ms: 210, cost: 0.002 }
        : { ok: true, answers, ms: 120, cost: 0.001 };
    });

  it('sends an opened survivor as one request with the description, replacing the grid badge', async () => {
    const gateway = gridThenDescribed();
    const session = new MarketplaceSession(gateway);
    const brief = {
      query: 'iPhone 13',
      maxPrice: 300000,
      currency: 'ARS' as const,
      note: 'Must be unlocked.',
    };
    const name = 'iPhone 13 128GB, $ 250.000, Palermo';
    const description = 'Cracked back glass, battery at 78%, comes with box.';

    const grid = await session.judgeWave(brief, [tile('501', name)], true);
    expect(gateway.requests).toHaveLength(1);
    expect(grid.badges).toEqual([{ id: '501', text: 'MATCH 2.6', tone: 'match' }]);

    // A stored grid judgment does not satisfy the open: it sends again.
    const opened = await session.judgeOpened(brief, tile('501', name, description), true);
    expect(gateway.requests).toHaveLength(2);
    const request = gateway.requests[1]!;
    expect(request.model).toBe('jev-1.13');
    expect(request.state.query).toBe('iPhone 13');
    expect(request.state.note).toBe('Must be unlocked.');
    expect(request.state.listings).toEqual([
      {
        id: '501',
        title: 'iPhone 13 128GB',
        price: 250000,
        currency: 'ARS',
        place: 'Palermo',
        description,
      },
    ]);
    expect(request.questions).toHaveLength(2);
    expect(request.questions.every((question) => question.name.includes('501'))).toBe(true);

    // The described verdict replaces the grid badge on the tile and panel.
    expect(opened.badges).toEqual([{ id: '501', text: 'REVIEW 1.5', tone: 'review' }]);
    expect(opened.unpainted).toEqual([]);
    expect(opened.panel.entries).toEqual([
      { id: '501', title: 'iPhone 13 128GB', verdict: 'REVIEW', fit: 1.5, reason: null },
    ]);
    expect(opened.panel.kept).toBe(0);
    expect(opened.panel.review).toBe(1);
    expect(opened.panel.lastMs).toBe(210);
    expect(opened.panel.totalCost).toBeCloseTo(0.003, 6);

    // Fit, confidence, dealbreaker, and ms update together on the described
    // judgment, which is the one the panel keeps for the item.
    const kept = session
      .snapshot()
      .judgments.find((judgment) => judgment.id === '501' && judgment.described);
    expect(kept).toMatchObject({
      verdict: 'REVIEW',
      fit: 1.5,
      fitConfidence: 0.9,
      dealbreaker: 0.1,
      ms: 210,
      description,
    });
  });

  it('reuses the described judgment on a second open and prefers it on the grid', async () => {
    const gateway = gridThenDescribed();
    const session = new MarketplaceSession(gateway);
    const brief = { query: 'iPhone 13' };
    const name = 'iPhone 13 128GB, Palermo';
    const description = 'Full box, battery replaced last year.';

    await session.judgeWave(brief, [tile('502', name)], true);
    const first = await session.judgeOpened(brief, tile('502', name, description), true);
    expect(gateway.requests).toHaveLength(2);
    expect(first.badges).toEqual([{ id: '502', text: 'REVIEW 1.5', tone: 'review' }]);

    // Same item, price, currency, brief, and description: no second payment.
    const second = await session.judgeOpened(brief, tile('502', name, description), true);
    expect(gateway.requests).toHaveLength(2);
    expect(second.badges).toEqual(first.badges);
    expect(second.unpainted).toEqual([]);
    expect(second.panel.lastMs).toBe(210);
    expect(second.panel.totalCost).toBeCloseTo(first.panel.totalCost, 6);

    // With both stored, the grid repaints the described judgment, unsent.
    const grid = await session.judgeWave(brief, [tile('502', name)], true);
    expect(gateway.requests).toHaveLength(2);
    expect(grid.badges).toEqual([{ id: '502', text: 'REVIEW 1.5', tone: 'review' }]);
    expect(grid.panel.entries).toEqual([
      { id: '502', title: 'iPhone 13 128GB', verdict: 'REVIEW', fit: 1.5, reason: null },
    ]);

    // The described judgment survives a reload in the same browser session.
    const afterGateway = gridThenDescribed();
    const reloaded = new MarketplaceSession(afterGateway, session.snapshot());
    const reopened = await reloaded.judgeOpened(brief, tile('502', name, description), true);
    expect(afterGateway.requests).toHaveLength(0);
    expect(reopened.badges).toEqual([{ id: '502', text: 'REVIEW 1.5', tone: 'review' }]);
  });

  it('keeps a local SKIP unsent when opened with a description', async () => {
    const gateway = new ScriptedGateway(() => ok());
    const session = new MarketplaceSession(gateway);
    const brief = { query: 'iPhone', maxPrice: 200000, currency: 'ARS' as const };
    const name = 'iPhone 13 128GB, $ 250.000, Palermo';
    const description = 'Mint condition, but over budget.';

    const grid = await session.judgeWave(brief, [tile('601', name)], true);
    expect(gateway.requests).toHaveLength(0);
    expect(grid.badges).toEqual([{ id: '601', text: 'SKIP price', tone: 'skip' }]);

    const opened = await session.judgeOpened(brief, tile('601', name, description), true);
    expect(gateway.requests).toHaveLength(0);
    expect(opened.badges).toEqual([{ id: '601', text: 'SKIP price', tone: 'skip' }]);
    expect(opened.unpainted).toEqual([]);
    expect(opened.panel.entries).toEqual([
      { id: '601', title: 'iPhone 13 128GB', verdict: 'SKIP', fit: null, reason: 'price' },
    ]);

    // Never gridded: a direct open of a local SKIP still sends nothing.
    const fresh = new MarketplaceSession(gateway);
    const direct = await fresh.judgeOpened(brief, tile('602', name, description), true);
    expect(gateway.requests).toHaveLength(0);
    expect(direct.badges).toEqual([{ id: '602', text: 'SKIP price', tone: 'skip' }]);
  });

  it('does not fold opened listings into grid chunks in a mixed wave', async () => {
    const gateway = new ScriptedGateway(
      answersFor({
        '701': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
        '702': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
        '703': { fit: 2.5, confidence: 0.9, dealbreaker: 0.0 },
      }),
    );
    const session = new MarketplaceSession(gateway);

    const result = await session.judgeWave(
      { query: 'lamp' },
      [
        tile('701', 'Lamp 701, Palermo'),
        tile('702', 'Lamp 702, Palermo'),
        tile('703', 'Lamp 703, Palermo', 'Seller notes a small scratch.'),
      ],
      true,
    );

    expect(gateway.requests).toHaveLength(2);
    const [gridChunk, openedSingle] = gateway.requests as [DecisionRequest, DecisionRequest];
    expect(gridChunk.state.listings.map((listing) => listing.id)).toEqual(['701', '702']);
    expect(gridChunk.questions).toHaveLength(4);
    expect(openedSingle.state.listings).toEqual([
      {
        id: '703',
        title: 'Lamp 703',
        price: null,
        currency: null,
        place: 'Palermo',
        description: 'Seller notes a small scratch.',
      },
    ]);
    expect(openedSingle.questions).toHaveLength(2);
    expect(result.badges).toHaveLength(3);
    expect(result.unpainted).toEqual([]);
  });
});
