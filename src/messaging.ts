import type { PanelModel } from './session/marketplace';
import type { BriefState } from './stores/brief';

// The content script owns the marketplace session. The side panel pulls the
// current view when it opens and the content script pushes updates after
// every wave. The key never appears in any message.
export const GET_VIEW = 'deal-hunter:get-view';
export const VIEW_UPDATED = 'deal-hunter:view-updated';

export interface ViewPayload {
  panel: PanelModel;
  brief: BriefState;
}

export interface GetViewMessage {
  type: typeof GET_VIEW;
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
