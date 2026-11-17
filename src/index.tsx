import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { perfMark } from './utils/perfMark';
import { IS_AGENT, IS_DEMO } from './utils/buildTarget';

perfMark('wk:entry-start');

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');
const root = ReactDOM.createRoot(rootElement);

(async () => {
  if (IS_DEMO) {
    const { installDemoFetch } = await import('./demo/demoApi');
    installDemoFetch();
    const { default: DemoBanner } = await import('./demo/DemoBanner');
    root.render(
      <React.StrictMode>
        <ErrorBoundary surface="cloud">
          <App />
          <DemoBanner />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } else if (IS_AGENT) {
    root.render(
      <React.StrictMode>
        <ErrorBoundary surface="agent">
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } else {
    const [{ ClerkProvider }, { default: CloudApp }] = await Promise.all([
      import('@clerk/clerk-react'),
      import('./cloud/CloudApp'),
    ]);
    perfMark('wk:clerk-module');
    const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
    perfMark('wk:render-called');
    root.render(
      <React.StrictMode>
        <ClerkProvider publishableKey={clerkPubKey}>
          <ErrorBoundary surface="cloud">
            <App cloudApp={CloudApp} />
          </ErrorBoundary>
        </ClerkProvider>
      </React.StrictMode>
    );
  }
})();
