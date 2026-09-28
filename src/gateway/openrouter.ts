import type {
  AnswerValue,
  DecisionRequest,
  Gateway,
  GatewayResult,
} from '../session/marketplace';
import { keyStore } from '../stores/key';

const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';

// Delivers a decision request to Jev through the shopper's own OpenRouter key
// and returns answers with the provider's billed cost and measured duration.
// The key travels only in the Authorization header.
export function createOpenRouterGateway(): Gateway {
  return {
    async send(request: DecisionRequest): Promise<GatewayResult> {
      const key = await keyStore.getValue();
      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(request),
        });
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Jev request failed.',
          ms: Date.now() - started,
        };
      }
      const ms = Date.now() - started;
      if (!response.ok) {
        return { ok: false, error: `Jev request failed (${response.status}).`, ms };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, error: 'Jev returned an unreadable answer.', ms };
      }
      return { ok: true, answers: readAnswers(payload), cost: readCost(payload), ms };
    },
  };
}

function readAnswers(payload: unknown): Record<string, AnswerValue> {
  if (typeof payload !== 'object' || payload === null) return {};
  const raw = (payload as { answers?: unknown }).answers;
  if (typeof raw !== 'object' || raw === null) return {};
  const answers: Record<string, AnswerValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    const answer = readAnswer(value);
    if (answer !== null) answers[name] = answer;
  }
  return answers;
}

function readAnswer(value: unknown): AnswerValue | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'score') {
    if (typeof record['value'] !== 'number') return null;
    if (typeof record['confidence'] !== 'number') return null;
    return { kind: 'score', value: record['value'], confidence: record['confidence'] };
  }
  if (record['kind'] === 'noul') {
    if (typeof record['probabilityTrue'] !== 'number') return null;
    return { kind: 'noul', probabilityTrue: record['probabilityTrue'] };
  }
  return null;
}

function readCost(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return 0;
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === 'number' ? cost : 0;
}
