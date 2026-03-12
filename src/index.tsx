import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Build-time flag injected by Vite when `vite build --mode agent` is used.
// The value is baked into the bundle at compile time via .env.agent, not read
// at runtime. Rollup treats it as a constant and eliminates dead branches.
const IS_AGENT = (import.meta.env.VITE_BUILD_TARGET as string) === 'agent';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');
const root = ReactDOM.createRoot(rootElement);

// IMPORTANT: ClerkProvider must NOT be imported at module scope here.
// A static `import { ClerkProvider } from '@clerk/clerk-react'` triggers
// Clerk's module-level initialization regardless of whether the component
// is rendered, causing a publishableKey error in the agent binary.
//
// The dynamic import() inside the else branch is dead code when IS_AGENT is
// true (build-time constant), so Rollup excludes the Clerk module from the
// agent bundle entirely.
(async () => {
  if (IS_AGENT) {
    // Agent / local binary: no Clerk. Auth is cloud-only.
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  } else {
    // Cloud build: Clerk is dynamically imported so the module is absent from
    // the agent bundle. Dynamic imports in Rollup dead-code branches are
    // tree-shaken when the branch condition is a build-time constant.
    const { ClerkProvider } = await import('@clerk/clerk-react');
    const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
    root.render(
      <React.StrictMode>
        <ClerkProvider publishableKey={clerkPubKey}>
          <App />
        </ClerkProvider>
      </React.StrictMode>
    );
  }
})();
