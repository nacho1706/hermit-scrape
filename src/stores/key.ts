import { storage } from 'wxt/utils/storage';

// The shopper's own OpenRouter key. Local storage only: it stays on this
// machine. Read only by the gateway, for the Authorization header. Never
// rendered, logged, or messaged anywhere.
export const keyStore = storage.defineItem<string>('local:openrouter-key', {
  defaultValue: '',
});

export async function hasKey(): Promise<boolean> {
  return (await keyStore.getValue()) !== '';
}
