import React from 'react';
import { SignIn } from '@clerk/clerk-react';

interface SignInPageProps {
  onNavigate: (path: string) => void;
}

const SignInPage: React.FC<SignInPageProps> = () => {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <SignIn
        routing="path"
        path="/sign-in"
        afterSignInUrl="/"
        signUpUrl="/sign-up"
      />
    </div>
  );
};

export default SignInPage;
