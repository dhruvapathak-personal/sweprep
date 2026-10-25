'use client';

import { useState } from 'react';

export function Login() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
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
        <h2 id="login-title">Sign in with email</h2>
        <p>
          No password to remember. We will send a secure sign-in link. Open it
          in this browser.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
              });
              setStatus(
                response.ok
                  ? 'Check your email for your sign-in link. Keep this tab open.'
                  : 'We could not send the link. Check your email address and try again shortly.',
              );
            } catch {
              setStatus('Connection unavailable. Reconnect and try again.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
          <button className="primary" disabled={busy}>
            {busy ? 'Sending link…' : 'Send sign-in link'}{' '}
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
