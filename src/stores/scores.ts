import { storage } from 'wxt/utils/storage';
import type { SessionSnapshot } from '../session/marketplace';

// This browser session's judgments: every MATCH, REVIEW, and SKIP painted
// so far, plus the counts, cost, and timing behind them. Session storage
// only: a reload reuses them, a browser restart drops them. The brief and
// the key live in local storage and survive restarts.
export const scoresStore = storage.defineItem<SessionSnapshot | null>('session:scores', {
  defaultValue: null,
});
