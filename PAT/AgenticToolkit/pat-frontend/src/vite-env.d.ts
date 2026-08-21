/// <reference types="vite/client" />

declare module '*.css';

// Runtime PUBLIC_ env injected as window.__PUBLIC_ENV__ (server/public-env.ts).
interface Window {
  __PUBLIC_ENV__?: Record<string, string>;
}
