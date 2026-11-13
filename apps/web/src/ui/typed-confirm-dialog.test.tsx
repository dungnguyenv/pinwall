import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { TypedConfirmDialog } from './index.ts';

function renderDialog(onConfirm: (typed: string) => Promise<unknown>) {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <TypedConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete all my content"
      body="This cannot be undone."
      confirmLabel="Delete everything"
      expected="ada@example.com"
      fieldLabel="Type ada@example.com to confirm"
      onConfirm={onConfirm}
    />,
  );
  return { user, onOpenChange };
}

const confirmButton = () => screen.getByRole('button', { name: 'Delete everything' });
const field = () => screen.getByRole('textbox', { name: 'Type ada@example.com to confirm' });

test('confirm follows a trimmed, case-insensitive match and passes the trimmed text', async () => {
  const onConfirm = vi.fn(() => Promise.resolve());
  const { user, onOpenChange } = renderDialog(onConfirm);

  expect(screen.getByRole('alertdialog', { name: 'Delete all my content' })).toBeInTheDocument();
  expect(confirmButton()).toBeDisabled();

  await user.type(field(), 'ada@example.co');
  expect(confirmButton()).toBeDisabled();

  await user.clear(field());
  await user.type(field(), '  ADA@example.com  ');
  expect(confirmButton()).toBeEnabled();

  // One more character and it no longer matches.
  await user.type(field(), 'm');
  expect(confirmButton()).toBeDisabled();
  await user.keyboard('{Backspace}');

  await user.click(confirmButton());
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onConfirm).toHaveBeenCalledWith('ADA@example.com');
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

test('a rejection keeps the dialog open with the reason, and the typed text stays', async () => {
  const onConfirm = vi.fn(() => Promise.reject(new Error('Try again.')));
  const { user, onOpenChange } = renderDialog(onConfirm);

  await user.type(field(), 'ada@example.com');
  await user.click(confirmButton());

  expect(await screen.findByText('Try again.')).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
  expect(field()).toHaveValue('ada@example.com');
  expect(confirmButton()).toBeEnabled();
});

test('the field starts empty each time the dialog opens', async () => {
  const user = userEvent.setup();
  const props = {
    onOpenChange: vi.fn(),
    title: 'Delete all my content',
    body: 'This cannot be undone.',
    confirmLabel: 'Delete everything',
    expected: 'ada@example.com',
    fieldLabel: 'Type ada@example.com to confirm',
    onConfirm: () => Promise.resolve(),
  };
  const { rerender } = render(<TypedConfirmDialog {...props} open />);
  await user.type(field(), 'ada@example.com');
  expect(confirmButton()).toBeEnabled();

  rerender(<TypedConfirmDialog {...props} open={false} />);
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  rerender(<TypedConfirmDialog {...props} open />);

  expect(field()).toHaveValue('');
  expect(confirmButton()).toBeDisabled();
});
