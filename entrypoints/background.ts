import { browser } from 'wxt/browser';

export default defineBackground(() => {
  // The toolbar icon opens the side panel; there is no popup.
  void browser.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});
