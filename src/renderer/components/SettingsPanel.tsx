import React, { useEffect, useState } from 'react';
import type { MpdbCredentials } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Settings modal for MPDB.tv credentials.
 *
 * The three values are persisted to the OS user-data directory (NOT in the
 * repo, NOT in the app bundle) via the `credentials:set` IPC handler. After
 * saving, the user can click "Tester" to verify the credentials work.
 *
 * Storage location:
 *   macOS:  ~/Library/Application Support/ArveCinema/credentials.json
 *   Linux:  ~/.config/ArveCinema/credentials.json
 *   Windows: %APPDATA%\ArveCinema\credentials.json
 */
export const SettingsPanel: React.FC<Props> = ({ open, onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [subscriptionKey, setSubscriptionKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);

  // Load stored credentials on open.
  useEffect(() => {
    if (!open) return;
    void window.electronAPI.getCredentials().then(creds => {
      if (creds) {
        setApiKey(creds.apiKey);
        setUsername(creds.username);
        setSubscriptionKey(creds.subscriptionKey);
      } else {
        setApiKey(''); setUsername(''); setSubscriptionKey('');
      }
      setTestResult(null);
      setSaved(false);
    });
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    const creds: MpdbCredentials = { apiKey, username, subscriptionKey };
    await window.electronAPI.setCredentials(creds);
    setSaved(true);
    setTestResult(null);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    // Save first so the test uses the latest values.
    await handleSave();
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI.testMpdb();
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#131313',
          border: '1px solid #2a2a2a',
          borderRadius: 12,
          padding: 24,
          width: '90%', maxWidth: 480,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Réglages</h2>
          <button
            onClick={onClose}
            aria-label="Fermer"
            style={{
              background: 'transparent', border: 'none', color: '#888',
              fontSize: 22, cursor: 'pointer', lineHeight: 1,
            }}
          >×</button>
        </div>

        <p style={{ margin: 0, color: '#888', fontSize: 13, lineHeight: 1.4 }}>
          Pour afficher les notes des films, configurez vos identifiants{' '}
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); void window.electronAPI.openTicket('https://mpdb.tv'); }}
            style={{ color: '#a855f7', textDecoration: 'underline' }}
          >MPDB.tv</a>. Les credentials sont stockés localement (jamais dans le code source).
        </p>

        <Field label="Clé API">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Votre clé API MPDB"
            style={inputStyle}
          />
        </Field>

        <Field label="Nom d'utilisateur MPDB">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Votre login MPDB.tv"
            style={inputStyle}
          />
        </Field>

        <Field label="Clé d'abonnement (subscription key)">
          <input
            type="password"
            value={subscriptionKey}
            onChange={(e) => setSubscriptionKey(e.target.value)}
            placeholder="Visible dans votre compte MPDB"
            style={inputStyle}
          />
        </Field>

        {testResult && (
          <div style={{
            padding: '8px 12px',
            borderRadius: 6,
            background: testResult.ok ? 'rgba(16,185,129,0.15)' : 'rgba(229,9,20,0.15)',
            border: `1px solid ${testResult.ok ? '#10b981' : '#e50914'}`,
            color: testResult.ok ? '#10b981' : '#e50914',
            fontSize: 13,
          }}>
            {testResult.ok ? '✓ ' : '⚠ '}{testResult.message}
          </div>
        )}

        {saved && !testResult && (
          <div style={{ color: '#10b981', fontSize: 13 }}>✓ Enregistré</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={secondaryButtonStyle}
          >Annuler</button>
          <button
            onClick={handleTest}
            disabled={testing || !apiKey || !username || !subscriptionKey}
            style={{
              ...primaryButtonStyle,
              opacity: (testing || !apiKey || !username || !subscriptionKey) ? 0.4 : 1,
              cursor: (testing || !apiKey || !username || !subscriptionKey) ? 'not-allowed' : 'pointer',
            }}
          >{testing ? 'Test…' : 'Enregistrer et tester'}</button>
        </div>
      </div>
    </div>
  );
};

// ── Style constants ───────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  background: '#0a0a0a',
  color: '#fff',
  border: '1px solid #333',
  borderRadius: 6,
  fontSize: 14,
  outline: 'none',
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: '#fff',
  color: '#000',
  border: 'none',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'transparent',
  color: '#888',
  border: '1px solid #333',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

// ── Field component ────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ color: '#888', fontSize: 12, fontWeight: 600 }}>{label}</label>
    {children}
  </div>
);
