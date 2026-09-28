import { keyStore } from '../../src/stores/key';

// Options page: the one place the OpenRouter key is entered. It is stored
// in local extension storage and never rendered back, not even here.
const keyInput = document.querySelector<HTMLInputElement>('#key')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const clearButton = document.querySelector<HTMLButtonElement>('#clear')!;
const status = document.querySelector('#status')!;

saveButton.addEventListener('click', () => {
  const key = keyInput.value.trim();
  if (key === '') {
    status.textContent = 'Paste a key first.';
    return;
  }
  void keyStore.setValue(key).then(() => {
    keyInput.value = '';
    status.textContent = 'Key saved on this machine.';
    void renderSavedState();
  });
});

clearButton.addEventListener('click', () => {
  void keyStore.setValue('').then(() => {
    keyInput.value = '';
    status.textContent = 'Key removed.';
    void renderSavedState();
  });
});

void renderSavedState();

async function renderSavedState(): Promise<void> {
  const saved = (await keyStore.getValue()) !== '';
  saveButton.textContent = saved ? 'Replace key' : 'Save key';
  if (status.textContent === '') {
    status.textContent = saved ? 'A key is saved.' : 'No key saved yet.';
  }
}
