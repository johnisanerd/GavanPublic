import { ClerkProvider } from '@clerk/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '@/App';
// Brand fonts (TheTest): DM Sans (display/body) + DM Mono (metadata/log labels).
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

// Runtime-injected by the server (prod) or the vite dev plugin — see
// server/public-env.ts. Never a build-time VITE_ var, so a deploy can't ship a
// keyless client.
const clerkPublishableKey = window.__PUBLIC_ENV__?.CLERK_PUBLISHABLE_KEY;
if (!clerkPublishableKey)
  throw new Error('CLERK_PUBLISHABLE_KEY missing — set PUBLIC_CLERK_PUBLISHABLE_KEY (Fly secret / .env)');

createRoot(root).render(
  <StrictMode>
    <ClerkProvider publishableKey={clerkPublishableKey} afterSignOutUrl="/">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ClerkProvider>
  </StrictMode>,
);
