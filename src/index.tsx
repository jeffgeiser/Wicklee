import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';

// Build-time flag: true when compiled for the local agent binary (VITE_BUILD_TARGET=agent).
// When true, ClerkProvider is NOT rendered — the agent binary has no cloud auth context.
const IS_AGENT = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {IS_AGENT ? (
      <App />
    ) : (
      <ClerkProvider publishableKey={clerkPubKey}>
        <App />
      </ClerkProvider>
    )}
  </React.StrictMode>
);
