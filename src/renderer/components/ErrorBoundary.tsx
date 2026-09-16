import React from 'react';

interface State {
  error: Error | null;
}

/**
 * SEC-04: catch any unhandled render-time exception and show a French
 * error panel with a "Recharger" button instead of an unmountable white
 * screen. Without this, a single malformed poster URL or unexpected shape
 * in a movie object would unmount the entire React tree.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }

  reload = () => {
    this.setState({ error: null });
    location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 60,
          textAlign: 'center',
          color: 'var(--text-primary)',
          background: 'var(--bg-primary)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, sans-serif',
        }}>
          <div style={{ fontSize: 40 }}>💥</div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
            Une erreur est survenue
          </h1>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14, maxWidth: 480 }}>
            L'application a rencontré un problème inattendu. Essayez de la recharger.
          </p>
          <pre style={{
            margin: 0,
            background: 'var(--bg-card-2)',
            padding: '12px 16px',
            borderRadius: 8,
            color: '#e50914',
            fontSize: 12,
            maxWidth: 600,
            overflow: 'auto',
            textAlign: 'left',
          }}>
            {this.state.error.message}
          </pre>
          <button
            onClick={this.reload}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--text-primary)',
              color: 'var(--bg-primary)',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Recharger
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
