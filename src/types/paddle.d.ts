/**
 * Paddle.js v2 type declarations (minimal — checkout overlay only).
 * Full SDK docs: https://developer.paddle.com/paddlejs/overview
 */

interface PaddleCheckoutOpenOptions {
  items: Array<{ priceId: string; quantity?: number }>;
  customData?: Record<string, string>;
  customer?: { email?: string };
  settings?: {
    displayMode?: 'overlay' | 'inline';
    theme?: 'light' | 'dark';
    successUrl?: string;
  };
}

interface PaddleInstance {
  Environment: { set: (env: 'sandbox' | 'production') => void };
  Setup: (options: { token?: string; seller?: number }) => void;
  Checkout: {
    open: (options: PaddleCheckoutOpenOptions) => void;
  };
  Initialize: (options: {
    environment?: 'sandbox' | 'production';
    token?: string;
    seller?: number;
  }) => void;
}

interface Window {
  Paddle?: PaddleInstance;
}
