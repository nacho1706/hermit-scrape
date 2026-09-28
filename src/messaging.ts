import type { PanelModel } from './session/marketplace';
import type { BriefState } from './stores/brief';

// The content script owns the marketplace session. The side panel pulls the
// current view when it opens and the content script pushes updates after
// every wave. CSV export is a pull as well: the panel asks and the content
// script answers with this browser session's judgments. The key never
// appears in any message.
export const GET_VIEW = 'deal-hunter:get-view';
export const VIEW_UPDATED = 'deal-hunter:view-updated';
export const GET_CSV = 'deal-hunter:get-csv';

export interface ViewPayload {
  panel: PanelModel;
  brief: BriefState;
}

export interface CsvPayload {
  csv: string;
}

export interface GetViewMessage {
  type: typeof GET_VIEW;
}

export interface GetCsvMessage {
  type: typeof GET_CSV;
}

export interface ViewUpdatedMessage {
  type: typeof VIEW_UPDATED;
  view: ViewPayload;
}

export function isGetView(message: unknown): message is GetViewMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === GET_VIEW
  );
}

export function isGetCsv(message: unknown): message is GetCsvMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === GET_CSV
  );
}

export function isCsvPayload(message: unknown): message is CsvPayload {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { csv?: unknown }).csv === 'string'
  );
}

export function isViewUpdated(message: unknown): message is ViewUpdatedMessage {
  if (
    typeof message !== 'object' ||
    message === null ||
    (message as { type?: unknown }).type !== VIEW_UPDATED
  ) {
    return false;
  }
  return (
    typeof (message as { view?: unknown }).view === 'object' &&
    (message as { view?: unknown }).view !== null
  );
}
