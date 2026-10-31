import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, expect, test } from 'vitest';
import App from './App';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test('uploads a text document and returns matching source passages', async () => {
  const user = userEvent.setup();
  const { container } = render(<App />);
  const file = new File([
    'The tenant must pay monthly rent by the fifth day of each month. The owner must provide written notice before entering the apartment. The lease ends on December 31 unless both parties sign an extension.',
  ], 'lease.txt', { type: 'text/plain' });

  await user.upload(container.querySelector('input[type="file"]'), file);
  expect(await screen.findAllByText('lease.txt')).toHaveLength(2);
  expect(await screen.findByText(/The tenant must pay monthly rent/)).toBeDefined();

  await user.clear(screen.getByLabelText('Ask about this document'));
  await user.type(screen.getByLabelText('Ask about this document'), 'When is rent due?');
  await user.click(screen.getByRole('button', { name: /find relevant evidence/i }));

  expect(await screen.findByText(/The tenant must pay monthly rent by the fifth day/)).toBeDefined();
  expect(screen.queryByText(/The owner must provide written notice/)).toBeNull();
});

test('restores uploaded documents from browser storage', async () => {
  const { container, unmount } = render(<App />);
  const file = new File(['A notice period of thirty days applies to this agreement.'], 'notice.txt', { type: 'text/plain' });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
  expect(await screen.findAllByText('notice.txt')).toHaveLength(2);
  const db = await openDB('briefcase-workspace', 1);
  await waitFor(async () => expect(await db.count('documents')).toBe(1));

  unmount();
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /^documents/i }));
  expect(await screen.findAllByText('notice.txt')).toHaveLength(2);
  db.close();
});

test('asks for Google OAuth setup before attempting Gmail import', async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole('button', { name: /import from gmail/i }));

  expect(await screen.findByRole('dialog', { name: /google access/i })).toBeDefined();
  expect(screen.getByText(/OAuth 2.0 web client ID/i)).toBeDefined();
});
