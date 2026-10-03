/**
 * On-demand Paddle.js loader.
 *
 * Paddle.js used to be a static <script> in index.html, so every visitor —
 * landing page, docs, the local agent dashboard — paid for a cross-origin
 * fetch + parse of a checkout SDK that only openTeamCheckout ever touches.
 * It is now injected the first time a checkout is requested.
 *
 * The promise is cached so concurrent/repeat callers share one <script>.
 * A failed load clears the cache so a later click can retry.
 */

const PADDLE_SRC = 'https://cdn.paddle.com/paddle/v2/paddle.js';

let paddlePromise: Promise<PaddleInstance> | null = null;

export function loadPaddle(): Promise<PaddleInstance> {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (paddlePromise) return paddlePromise;

  paddlePromise = new Promise<PaddleInstance>((resolve, reject) => {
    const fail = (msg: string) => {
      paddlePromise = null;
      script.remove();
      reject(new Error(msg));
    };
    const script = document.createElement('script');
    script.src = PADDLE_SRC;
    script.async = true;
    script.onload = () => {
      if (window.Paddle) resolve(window.Paddle);
      else fail('Paddle.js loaded but window.Paddle is missing');
    };
    script.onerror = () => fail('Paddle.js failed to load');
    document.head.appendChild(script);
  });
  return paddlePromise;
}
