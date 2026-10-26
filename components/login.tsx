'use client';

import { useEffect, useState } from 'react';

export function Login() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const auth = new URLSearchParams(window.location.search).get('auth');
    queueMicrotask(() => {
      if (auth === 'denied')
        setStatus('Google sign-in was cancelled. You can try again.');
      else if (auth === 'failed')
        setStatus('This sign-in could not be completed. Please try again.');
    });
  }, []);
  return (
    <div className="login-layout">
      <section className="intro">
        <span className="eyebrow">A deliberate practice space</span>
        <h1>
          One question.
          <br />
          Clear reasoning.
        </h1>
        <p className="lede">
          Take your time. Explain the trade-offs. Keep a durable record of how
          you think.
        </p>
        <div className="principles">
          <span>01 · Think deeply</span>
          <span>02 · Explain precisely</span>
          <span>03 · Return and reflect</span>
        </div>
      </section>
      <section className="panel login-panel" aria-labelledby="login-title">
        <span className="eyebrow">Your private study history</span>
        <h2 id="login-title">Sign in with Google</h2>
        <p>
          Use your Google account to keep your practice and history together.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setStatus('');
            try {
              const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              if (!response.ok) throw new Error('UNAVAILABLE');
              const { url } = await response.json();
              window.location.assign(url);
            } catch {
              setStatus(
                'Google sign-in is unavailable. Please try again shortly.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <button className="primary" disabled={busy}>
            {busy ? 'Connecting…' : 'Continue with Google'}{' '}
            <span aria-hidden="true">→</span>
          </button>
          <p role="status">{status}</p>
        </form>
        <p className="fine-print">
          Private by design. Your answers and drafts belong to your account.
        </p>
      </section>
    </div>
  );
}
