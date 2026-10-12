import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ConfirmProvider, ToastProvider } from './components/ui';
import { AppProvider } from './lib/store';
import './index.css';

// Toast and Confirm wrap AppProvider so the store (and everything below it) can use both.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
