import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderRoute } from './test/render.tsx';

test('renders the sign-in page for a signed-out visitor', async () => {
  const { router } = renderRoute('/', { me: null });
  expect(await screen.findByRole('heading', { name: /Pinwall/ })).toBeInTheDocument();
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
});
