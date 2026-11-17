import React from 'react';
import { useAuth, useUser, useOrganization } from '@clerk/clerk-react';
import { perfMark } from '../utils/perfMark';

const CloudApp: React.FC<{ AppCore: React.FC<any> }> = ({ AppCore }) => {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const { user } = useUser();
  const { organization, membership } = useOrganization();
  const orgId = organization?.id ?? null;
  const orgRole = membership?.role ?? null;
  React.useEffect(() => {
    if (isLoaded) perfMark('wk:clerk-loaded');
  }, [isLoaded]);
  return <AppCore isSignedIn={isSignedIn} isLoaded={isLoaded} getToken={getToken} user={user} orgId={orgId} orgRole={orgRole} />;
};

export default CloudApp;
