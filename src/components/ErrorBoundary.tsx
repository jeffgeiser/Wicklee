import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label for which surface failed, shown in logs. */
  surface?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle exceptions in the subtree so one throwing component
 * — a malformed insight card, a bad parse in a detail panel — can't blank the
 * entire dashboard. Without this, any uncaught error unmounts the whole React
 * tree to a white screen with no recovery.
 *
 * Shows a minimal fallback with a reload affordance and a "Try again" that
 * clears the error state to re-attempt the render (useful when the cause was
 * transient bad data that has since updated).
 */
export default class ErrorBoundary extends Component<Props, State> {
  // This project ships no React type declarations (no @types/react; React
  // resolves as implicit `any`), so the inherited class members aren't
  // visible to TS. Declare the two this boundary uses — type-only, no
  // runtime effect — rather than pulling in @types/react app-wide.
  declare props: Props;
  declare setState: (partial: Partial<State>) => void;

  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaced to the console (and any wired error reporting) rather than
    // swallowed silently — the SSE path already logs; this covers render.
    console.error(`[error-boundary${this.props.surface ? `:${this.props.surface}` : ''}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#111827',
          color: '#f9fafb',
          fontFamily: 'Inter, system-ui, sans-serif',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.75rem' }}>
            Something went wrong rendering this view
          </h1>
          <p style={{ color: '#9ca3af', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            The dashboard hit an unexpected error. Your fleet and agents are unaffected —
            this is a display issue. Try again, or reload the page.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button
              onClick={this.reset}
              style={{
                padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid #374151',
                background: '#1f2937', color: '#f9fafb', cursor: 'pointer', fontSize: '0.875rem',
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid #2563eb',
                background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '0.875rem',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
