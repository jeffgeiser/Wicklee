import React from 'react';
import { SignIn } from '@clerk/clerk-react';
import { safeRedirectPath } from './utils/authRedirect';

interface SignInPageProps {
  onNavigate: (path: string) => void;
}

const SignInPage: React.FC<SignInPageProps> = () => {
  const [redirect] = React.useState(() => safeRedirectPath(window.location.search));
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <SignIn
        routing="path"
        path="/sign-in"
        fallbackRedirectUrl="/"
        forceRedirectUrl={redirect ?? undefined}
        signUpForceRedirectUrl={redirect ?? undefined}
        signUpUrl={redirect ? `/sign-up?redirect_url=${encodeURIComponent(redirect)}` : '/sign-up'}
      />
    </div>
  );
};

export default SignInPage;
