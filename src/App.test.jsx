import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Blob as NativeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, expect, test } from 'vitest';
import App from './App';

const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:bodycam' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  if (createObjectUrlDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
  else delete URL.createObjectURL;
  if (revokeObjectUrlDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
  else delete URL.revokeObjectURL;
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
  const db = await openDB('briefcase-workspace', 2);
  await waitFor(async () => expect(await db.count('documents')).toBe(1));

  unmount();
  render(<App />);
  await userEvent.click(screen.getByRole('button', { name: /^documents/i }));
  expect(await screen.findAllByText('notice.txt')).toHaveLength(2);
  db.close();
});

test('uploads and saves body-camera video larger than the former size limit', async () => {
  const { container, unmount } = render(<App />);
  const size = 16 * 1024 * 1024;
  const footage = new File([new Uint8Array(size)], 'bodycam.mp4', { type: 'video/mp4' });
  Object.defineProperty(footage, 'slice', {
    value: () => new NativeBlob([new Uint8Array(size)], { type: 'video/mp4' }),
  });

  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [footage] } });

  expect(await screen.findAllByText('bodycam.mp4')).toHaveLength(2);
  expect(await screen.findByText('Footage saved on this device')).toBeDefined();
  await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:bodycam'));

  const db = await openDB('briefcase-workspace', 2);
  const saved = (await db.getAll('documents'))[0];
  expect(saved.kind).toBe('video');
  expect(saved.size).toBe(size);
  const media = await db.get('media', saved.id);
  expect(media.blob.size).toBe(size);

  unmount();
  const reopened = render(<App />);
  expect(await screen.findAllByText('bodycam.mp4')).toHaveLength(2);
  await waitFor(() => expect(reopened.container.querySelector('video')?.getAttribute('src')).toBe('blob:bodycam'));
  db.close();
});

test('asks for Google OAuth setup before attempting Gmail import', async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole('button', { name: /import from gmail/i }));

  expect(await screen.findByRole('dialog', { name: /google access/i })).toBeDefined();
  expect(screen.getByText(/OAuth 2.0 web client ID/i)).toBeDefined();
});
