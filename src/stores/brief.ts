import { storage } from 'wxt/utils/storage';

// The shopper's brief. Slice #2 only carries the product query; max price,
// currency, places, and the note arrive with #3.
export interface BriefState {
  query: string;
}

export const briefStore = storage.defineItem<BriefState>('local:brief', {
  defaultValue: { query: '' },
});
