import { storage } from 'wxt/utils/storage';

// The shopper's brief. Max price is null when the shopper sets no cap;
// currency defaults to ARS; places are case- and accent-insensitive
// substrings, split on semicolons at input so commas stay literal (a
// substantial comma-part still matches, for old comma-separated lists);
// note is empty when the shopper left it empty. Stored locally: it stays on this
// machine. Older stored briefs may lack the newer fields; the session
// normalizes missing values to these defaults.
export interface BriefState {
  query: string;
  maxPrice: number | null;
  currency: 'ARS' | 'USD';
  places: string[];
  note: string;
}

export const briefStore = storage.defineItem<BriefState>('local:brief', {
  defaultValue: { query: '', maxPrice: null, currency: 'ARS', places: [], note: '' },
});
