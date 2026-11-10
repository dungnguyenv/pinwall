import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from './App.tsx';

test('renders the app name', () => {
  render(<App />);
  expect(screen.getByText('Pinwall')).toBeInTheDocument();
});
