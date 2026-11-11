import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createQueryClient } from './api/query-client.ts';
import { createAppRouter } from './app/router.tsx';
import './i18n.ts';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

// One router and one query client for the page's lifetime, made outside React.
const router = createAppRouter();
const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
