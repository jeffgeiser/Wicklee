import React from 'react';
import { SignUp } from '@clerk/clerk-react';

interface SignUpPageProps {
  onNavigate: (path: string) => void;
}

const SignUpPage: React.FC<SignUpPageProps> = () => {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <SignUp
        routing="path"
        path="/sign-up"
        afterSignUpUrl="/"
        signInUrl="/sign-in"
      />
    </div>
  );
};

export default SignUpPage;
