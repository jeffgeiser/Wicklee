import React, { useState } from 'react';
import { X, Mail, Lock, User as UserIcon, AlertCircle } from 'lucide-react';
import { User } from '../types';

interface AuthModalProps {
  mode: 'signin' | 'signup';
  onSuccess: (user: User, token: string) => void;
  onClose: () => void;
}

const AuthModal: React.FC<AuthModalProps> = ({ mode: initialMode, onSuccess, onClose }) => {
  const [activeMode, setActiveMode] = useState<'signin' | 'signup'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const cloudBase = (() => {
      const v = import.meta.env.VITE_CLOUD_URL ?? '';
      if (!v) return 'https://vibrant-fulfillment-production-62c0.up.railway.app';
      return v.startsWith('http') ? v : `https://${v}`;
    })();

    try {
      const endpoint = `${cloudBase}${activeMode === 'signup' ? '/api/auth/signup' : '/api/auth/login'}`;
      const body = activeMode === 'signup'
        ? { email, password, full_name: fullName }
        : { email, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        return;
      }

      // Map backend UserResponse → frontend User shape
      const user: User = {
        id:       data.user.id,
        email:    data.user.email,
        fullName: data.user.fullName,
        role:     data.user.role,
        isPro:    data.user.isPro ?? false,
      };

      onSuccess(user, data.token);
    } catch {
      setError('Unable to reach the auth service. Running the local agent? Use local mode below.');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m: 'signin' | 'signup') => {
    setActiveMode(m);
    setError('');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-gray-950 border border-gray-800 w-full max-w-md rounded-[28px] overflow-hidden shadow-2xl shadow-blue-500/10 animate-in zoom-in-95 duration-200">
        <div className="relative p-8 space-y-6">
          <button
            onClick={onClose}
            className="absolute top-6 right-6 p-2 text-gray-500 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="text-center space-y-1">
            <h2 className="text-2xl font-bold text-white">
              {activeMode === 'signin' ? 'Welcome back' : 'Create your account'}
            </h2>
            <p className="text-sm text-gray-500">
              {activeMode === 'signin'
                ? 'Sign in to your Wicklee account'
                : 'Start managing your GPU fleet'}
            </p>
          </div>

          {/* Mode tabs */}
          <div className="flex bg-gray-900 rounded-xl p-1">
            {(['signin', 'signup'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${
                  activeMode === m
                    ? 'bg-gray-800 text-white shadow'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {m === 'signin' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {activeMode === 'signup' && (
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  className="w-full pl-10 pr-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>
            )}

            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="w-full pl-10 pr-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              <input
                type="password"
                placeholder={activeMode === 'signup' ? 'Password (min 8 characters)' : 'Password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete={activeMode === 'signup' ? 'new-password' : 'current-password'}
                className="w-full pl-10 pr-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-white placeholder-gray-600 text-sm focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-500/20"
            >
              {loading
                ? 'Please wait…'
                : activeMode === 'signin'
                ? 'Sign In'
                : 'Create Account'}
            </button>
          </form>

          <div className="text-center">
            <a
              href="https://github.com/jeffgeiser/Wicklee#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              Don't have an agent yet? See the install guide →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuthModal;
