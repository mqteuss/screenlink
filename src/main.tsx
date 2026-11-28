import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './visual-tokens.css';
import './motion.css';
import './room.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if ('serviceWorker' in navigator && window.isSecureContext && !(window as Window & { screenLinkDesktop?: { isDesktop?: boolean } }).screenLinkDesktop?.isDesktop) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, { once: true });
}
