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
        const detail = await readErrorDetail(response);
        return { ok: false, error: `Jev request failed (${response.status}).${detail}`, ms };
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

// The server's own explanation for a rejected request, appended to the
// status error. OpenRouter shapes it as { error: { message } }; anything
// else falls back to the raw body. Bounded so the panel stays readable,
// and it never carries the key: the key only travels in the request header.
async function readErrorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return '';
  }
  const trimmed = text.trim();
  if (trimmed === '') return '';
  // The full body also goes to the page console, untruncated, for copying.
  console.error('[deal-hunter] Jev error body:', trimmed);
  try {
    const payload = JSON.parse(trimmed) as { error?: unknown };
    const error = payload.error;
    const message =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : error;
    if (typeof message === 'string' && message.trim() !== '') {
      return ` ${truncate(message.trim())}`;
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return ` ${truncate(trimmed)}`;
}

function truncate(value: string): string {
  // Long enough for a full multi-issue validation error to stay readable.
  return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
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
  // Documented wire shape: score carries its level (possibly fractional)
  // plus confidence; noul carries only the belief itself.
  if (record['type'] === 'score') {
    if (typeof record['score'] !== 'number') return null;
    if (typeof record['confidence'] !== 'number') return null;
    return { kind: 'score', value: record['score'], confidence: record['confidence'] };
  }
  if (record['type'] === 'noul') {
    if (typeof record['noul'] !== 'number') return null;
    return { kind: 'noul', probabilityTrue: record['noul'] };
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
