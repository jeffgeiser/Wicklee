import React from 'react';
import { useClerk, useAuth } from '@clerk/clerk-react';
import { LogOut, UserCog } from 'lucide-react';

/**
 * Clerk-dependent account actions (Manage Account + Sign Out).
 * Extracted to its own file so `@clerk/clerk-react` is only imported when this
 * chunk is loaded — which only happens in cloud builds where ClerkProvider exists.
 * Agent builds never load this chunk, avoiding the "Missing publishableKey" error.
 */
const ClerkAccountActions: React.FC<{
  onClose: () => void;
  onNavigateSettings: () => void;
}> = ({ onClose, onNavigateSettings: _nav }) => {
  const { signOut, openUserProfile } = useClerk();
  const { getToken } = useAuth();

  const handleSignOut = async () => {
    onClose();
    // Revoke stream tokens before signing out (fire-and-forget).
    try {
      const jwt = await getToken();
      if (jwt) {
        const cloud = (import.meta.env.VITE_CLOUD_URL ?? '') as string;
        fetch(`${cloud}/api/auth/stream-token`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${jwt}` },
        }).catch(() => {});
      }
    } catch { /* best-effort */ }
    signOut({ redirectUrl: '/' });
  };

  return (
    <div className="mt-1.5 pt-1.5 border-t border-gray-100 dark:border-gray-800/50 space-y-0.5">
      <button
        onClick={() => { onClose(); openUserProfile(); }}
        className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-white transition-colors flex items-center gap-2"
      >
        <UserCog className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        Manage Account
      </button>
      <button
        onClick={handleSignOut}
        className="w-full text-left px-3 py-2 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center gap-2"
      >
        <LogOut className="w-4 h-4" />
        Sign Out
      </button>
    </div>
  );
};

export default ClerkAccountActions;
