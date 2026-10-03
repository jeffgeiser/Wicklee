import React from 'react';
import { SignUp } from '@clerk/clerk-react';
import { safeRedirectPath } from './utils/authRedirect';

interface SignUpPageProps {
  onNavigate: (path: string) => void;
}

const SignUpPage: React.FC<SignUpPageProps> = () => {
  // ?redirect_url=/pricing?… (from the Team checkout button) returns the user
  // there after auth — including via the "Sign in" link. Read once on mount:
  // Clerk's multi-step routes (/sign-up/verify-email-address, …) may drop the query.
  const [redirect] = React.useState(() => safeRedirectPath(window.location.search));
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <SignUp
        routing="path"
        path="/sign-up"
        fallbackRedirectUrl="/"
        forceRedirectUrl={redirect ?? undefined}
        signInForceRedirectUrl={redirect ?? undefined}
        signInUrl={redirect ? `/sign-in?redirect_url=${encodeURIComponent(redirect)}` : '/sign-in'}
      />
    </div>
  );
};

export default SignUpPage;
