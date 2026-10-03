import React from 'react';
import { useAuth, useUser, useOrganization } from '@clerk/clerk-react';
import { perfMark } from '../utils/perfMark';

// Lazy-loaded wrapper that calls Clerk hooks inside ClerkProvider context.
// By isolating this in its own file (loaded via React.lazy), @clerk/clerk-react
// is excluded from the main bundle in agent builds — preventing the
// "Missing publishableKey" error on localhost.

// AppCore is imported from App.tsx — we need to receive it as a prop to avoid
// a circular dependency (App.tsx lazy-imports this file).
const CloudApp: React.FC<{ AppCore: React.FC<any> }> = ({ AppCore }) => {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const { user } = useUser();
  const { organization } = useOrganization();
  const orgId = organization?.id ?? null;
  // When ClerkJS has finished loading and resolved the session (or its absence).
  React.useEffect(() => {
    if (isLoaded) perfMark('wk:clerk-loaded');
  }, [isLoaded]);
  return <AppCore isSignedIn={isSignedIn} isLoaded={isLoaded} getToken={getToken} user={user} orgId={orgId} />;
};

export default CloudApp;
