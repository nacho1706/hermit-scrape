import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterGateway } from '../src/gateway/openrouter';
import type { DecisionRequest } from '../src/session/marketplace';

vi.mock('../src/stores/key', () => ({
  keyStore: { getValue: async () => 'test-key' },
}));

const request: DecisionRequest = {
  model: 'jev-1.13',
  state: { query: 'iPhone 13', note: '', listings: [] },
  questions: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openrouter gateway errors', () => {
  it('keeps the server explanation on a 400', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { message: 'No model jev-1.13 found.', code: 400 } }), {
          status: 400,
        }),
    );

    const result = await createOpenRouterGateway().send(request);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('(400)');
      expect(result.error).toContain('No model jev-1.13 found.');
    }
  });

  it('falls back to the status when the 400 body is empty', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 400 }));

    const result = await createOpenRouterGateway().send(request);

    expect(result).toEqual({ ok: false, error: 'Jev request failed (400).', ms: expect.any(Number) });
  });

  it('still parses answers and cost on success', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            answers: { 'fit-1': { type: 'score', score: 2.5, confidence: 0.9 } },
            usage: { cost: 0.002 },
          }),
          { status: 200 },
        ),
    );

    const result = await createOpenRouterGateway().send(request);

    expect(result).toEqual({
      ok: true,
      answers: { 'fit-1': { kind: 'score', value: 2.5, confidence: 0.9 } },
      cost: 0.002,
      ms: expect.any(Number),
    });
  });

  it('parses the documented wire answer shape', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              'fit-1': { type: 'score', score: 2.5, confidence: 0.9 },
              'dealbreaker-1': { type: 'noul', noul: 0.1 },
            },
            usage: { cost: 0.002 },
          }),
          { status: 200 },
        ),
    );

    const result = await createOpenRouterGateway().send(request);

    expect(result).toEqual({
      ok: true,
      answers: {
        'fit-1': { kind: 'score', value: 2.5, confidence: 0.9 },
        'dealbreaker-1': { kind: 'noul', probabilityTrue: 0.1 },
      },
      cost: 0.002,
      ms: expect.any(Number),
    });
  });

  it('keeps a long server explanation in full', async () => {
    const message = `validation failed: ${'x'.repeat(300)}`;
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ error: { message } }), { status: 400 }),
    );
    // Silence the console copy of the body for this probe.
    const logged: unknown[][] = [];
    vi.stubGlobal('console', { ...console, error: (...args: unknown[]) => void logged.push(args) });

    const result = await createOpenRouterGateway().send(request);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(message);
      expect(result.error).not.toContain('…');
    }
    expect(logged.length).toBe(1);
  });
});
