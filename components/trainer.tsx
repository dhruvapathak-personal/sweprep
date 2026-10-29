'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { StudyAction, StudyState } from '@/lib/contracts/study';
import { changeState, readState } from '@/lib/client/api';
import { clearDrafts } from '@/lib/client/drafts';
import { Login } from '@/components/login';
import { Question } from '@/components/question';
import { AnswerEditor } from '@/components/answer-editor';
import { Grade } from '@/components/grade';
import { ContentCatalog } from '@/components/content-catalog';

export function Trainer() {
  const [state, setState] = useState<StudyState | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [recoveryWriterId, setRecoveryWriterId] = useState<string>();
  const authEpoch = useRef(0);

  const update = useCallback((next: StudyState) => {
    setState((current) => (current?.userId === next.userId ? next : current));
  }, []);
  const change = useCallback(async (action: StudyAction) => {
    const epoch = authEpoch.current;
    const result = await changeState(action);
    if (epoch !== authEpoch.current) throw new Error('UNAUTHENTICATED');
    setState(result.state);
    return result.state;
  }, []);

  const load = useCallback(async () => {
    const epoch = authEpoch.current;
    try {
      const next = await readState();
      if (epoch !== authEpoch.current) return;
      if (next) {
        try {
          const previous = localStorage.getItem('sweprep-account');
          if (previous && previous !== next.userId) await clearDrafts();
          if (epoch !== authEpoch.current) return;
          localStorage.setItem('sweprep-account', next.userId);
        } catch {}
      }
      if (epoch !== authEpoch.current) return;
      setState(next);
      setError('');
    } catch (reason) {
      if (epoch !== authEpoch.current) return;
      setError(
        reason instanceof Error ? reason.message : 'Study service unavailable.',
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const id: string = crypto.randomUUID();
      try {
        const saved = z.uuid().safeParse(sessionStorage.getItem('sweprep-tab'));
        if (saved.success) setRecoveryWriterId(saved.data);
      } catch {}
      setDeviceId(id);
      void load();
    });
    return () => {
      cancelled = true;
      authEpoch.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const accountChanged = (event: StorageEvent) => {
      if (event.key === 'sweprep-account') {
        authEpoch.current += 1;
        setBusy(false);
        setState(undefined);
        setSelected(null);
        void load();
      }
    };
    window.addEventListener('storage', accountChanged);
    return () => window.removeEventListener('storage', accountChanged);
  }, [load]);

  useEffect(() => {
    const hasPending = state?.jobs.some((job) =>
      ['pending', 'grading', 'retry_wait'].includes(job.state),
    );
    if (!hasPending) return;
    const poll = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(poll);
  }, [load, state?.jobs]);

  async function run(action: StudyAction) {
    const epoch = authEpoch.current;
    setBusy(true);
    setError('');
    try {
      const next = await change(action);
      if (action.action === 'start') {
        setSelected(
          next.items.find((value) => value.state === 'answering')?.id ?? null,
        );
        setShowHistory(false);
      }
    } catch (reason) {
      if (epoch !== authEpoch.current) return;
      if (
        reason instanceof Error &&
        ['CONTENT_CHANGED', 'CONTENT_REVOKED'].includes(reason.message)
      )
        setCatalogEpoch((value) => value + 1);
      setError(
        reason instanceof Error ? reason.message : 'Request unavailable.',
      );
    } finally {
      if (epoch === authEpoch.current) setBusy(false);
    }
  }

  async function signOut() {
    if (
      !window.confirm(
        'Sign out? Only acknowledged cloud drafts can be resumed after local recovery copies are cleared. Save your answer first.',
      )
    )
      return;
    let epoch = ++authEpoch.current;
    setBusy(true);
    try {
      const response = await fetch('/api/study', { method: 'DELETE' });
      if (epoch !== authEpoch.current) return;
      if (!response.ok) throw new Error('Sign-out failed. Please try again.');
      epoch = ++authEpoch.current;
      setState(null);
      setSelected(null);
      try {
        localStorage.removeItem('sweprep-account');
      } catch {}
      await clearDrafts();
    } catch (reason) {
      if (epoch !== authEpoch.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : 'Local drafts could not be cleared. Close this browser before switching accounts.',
      );
    } finally {
      if (epoch === authEpoch.current) setBusy(false);
    }
  }

  const active = state?.items.find((value) => value.state === 'answering');
  const item = !showHistory
    ? (state?.items.find((value) => value.id === selected) ??
      active ??
      state?.items[0])
    : null;
  const question = state?.pinnedQuestions.find(
    (value) => value.id === item?.question_version_id,
  );
  const attempt = state?.attempts.find((value) => value.item_id === item?.id);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to study content
      </a>
      <header className="site-header">
        <div className="wordmark">
          <span className="brand-icon" aria-hidden="true">
            s
          </span>
          SWE<span>trainer</span>
        </div>
        <div className="header-right">
          <span className="phase-label">TEXT PRACTICE · MVP 1</span>
          {state && (
            <button
              className="quiet"
              disabled={busy || Boolean(active && item?.state === 'answering')}
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      <main id="main">
        {error && (
          <div role="alert" className="notice warning">
            {error}{' '}
            <button className="quiet" onClick={() => void load()}>
              Reload cloud state
            </button>
          </div>
        )}
        {state === undefined ? (
          <section className="panel loading" role="status">
            <h1>Opening your practice space…</h1>
            <p>Checking your session and cloud history.</p>
          </section>
        ) : state === null ? (
          <Login />
        ) : (
          <>
            <div className="workspace-heading">
              <div>
                <span className="eyebrow">Focused practice · no rush</span>
                <h1>Reason it through.</h1>
              </div>
              <div className="today">
                <span className="eyebrow">Today · acknowledged</span>
                <strong>
                  {Math.floor(state.todayMs / 60000)}m{' '}
                  {Math.floor(state.todayMs / 1000) % 60}s
                </strong>
                <span>{state.timezone}</span>
              </div>
            </div>
            <div className="notice simulation-banner">
              <strong>
                {state.gradingMode === 'simulated'
                  ? 'Simulated grading / not readiness evidence'
                  : state.gradingMode === 'disabled'
                    ? 'Live grading is disabled'
                    : 'Readiness: insufficient evidence'}
              </strong>
              <span>
                Only policy-qualified current content is offered.{' '}
                {state.gradingMode === 'simulated'
                  ? 'Local demo scores do not assess your answer and never update mastery.'
                  : 'Qualification execution and live release remain disabled; model, privacy, budget and recovery approval are separate.'}
              </span>
            </div>
            <div className="workspace">
              <article className="panel study-panel">
                {item && question ? (
                  <>
                    <div className="study-topline">
                      <span>QUESTION 1 / 1</span>
                      <span>
                        {item.source === 'first' ? 'First attempt' : 'Review'} ·{' '}
                        {item.state === 'answering'
                          ? 'In progress'
                          : 'Submitted'}
                      </span>
                    </div>
                    <Question question={question} />
                    {item.state === 'answering' ? (
                      <AnswerEditor
                        key={item.id}
                        item={item}
                        state={state}
                        deviceId={deviceId}
                        recoveryWriterId={recoveryWriterId}
                        change={change}
                        updated={update}
                        leave={() => setShowHistory(true)}
                      />
                    ) : attempt ? (
                      <Grade
                        state={state}
                        attemptId={attempt.id}
                        busy={busy}
                        retry={() =>
                          void run({ action: 'retry', attemptId: attempt.id })
                        }
                      />
                    ) : null}
                    {item.state !== 'answering' && (
                      <div className="next-step">
                        <button
                          className="secondary"
                          onClick={() => setShowHistory(true)}
                        >
                          Choose another question
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <section className="question">
                    <span className="eyebrow">A small, deliberate start</span>
                    <h2>
                      {active
                        ? 'Your draft is waiting.'
                        : 'Choose a question to begin.'}
                    </h2>
                    <p>
                      {active
                        ? 'Your active answer stays in your cloud history. Resume it before beginning another question.'
                        : 'One question per session. Unqualified candidates stay private; an empty bank does not unlock them.'}
                    </p>
                    {active && (
                      <button
                        className="primary"
                        onClick={() => {
                          setSelected(active.id);
                          setShowHistory(false);
                        }}
                      >
                        Resume saved draft →
                      </button>
                    )}
                    <ContentCatalog
                      key={`${state.userId}:${catalogEpoch}`}
                      disabled={busy || Boolean(active)}
                      start={(id) =>
                        void run({
                          action: 'start',
                          questionId: id,
                          timezone:
                            Intl.DateTimeFormat().resolvedOptions().timeZone,
                        })
                      }
                    />
                  </section>
                )}
              </article>
              <aside className="sidebar">
                <section className="panel">
                  <span className="eyebrow">Your practice ledger</span>
                  <h3>Saved history</h3>
                  <p className="fine-print">
                    Latest 100 immutable attempts. Submitted and scored are
                    separate states.
                  </p>
                  {active && (
                    <button
                      className="history-entry draft-entry"
                      onClick={() => {
                        setSelected(active.id);
                        setShowHistory(false);
                      }}
                    >
                      <span className="status-dot saved" />
                      <span>
                        <strong>Resume active draft</strong>
                        <small>Cloud version {active.version}</small>
                      </span>
                    </button>
                  )}
                  {state.attempts.length === 0 ? (
                    <p className="empty-note">
                      Your first submitted answer will appear here.
                    </p>
                  ) : (
                    <ol className="history-list">
                      {state.attempts.map((value) => {
                        const job = state.jobs.find(
                          (entry) => entry.attempt_id === value.id,
                        );
                        const title = state.pinnedQuestions.find(
                          (entry) => entry.id === value.question_version_id,
                        )?.title;
                        return (
                          <li key={value.id}>
                            <button
                              className={`history-entry ${item?.id === value.item_id ? 'selected' : ''}`}
                              disabled={Boolean(
                                active && item?.state === 'answering',
                              )}
                              onClick={() => {
                                setSelected(value.item_id);
                                setShowHistory(false);
                              }}
                            >
                              <span>
                                <strong>{title}</strong>
                                <small>
                                  {new Date(
                                    value.submitted_at,
                                  ).toLocaleDateString(undefined, {
                                    timeZone: state.timezone,
                                  })}{' '}
                                  · {value.source} · {job?.state}
                                </small>
                              </span>
                              <span aria-hidden="true">↗</span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>
                <section className="practice-note">
                  <span className="eyebrow">A note on evidence</span>
                  <p>Clear reasoning matters more than a quick answer.</p>
                  <p className="fine-print">
                    Voice, vocabulary practice, adaptive sessions, charts and
                    installation are not part of this release.
                  </p>
                  {state.gradingMode === 'simulated' && (
                    <details>
                      <summary>Local recovery demo</summary>
                      <p className="fine-print">
                        Begin an answer with <code>[simulate-failure]</code> for
                        a first-generation failure, then retry. Begin with{' '}
                        <code>[simulate-uncertain]</code> for an unscored
                        result. These controls work only in the local simulator.
                      </p>
                    </details>
                  )}
                </section>
                <p className="account-label">{state.email}</p>
              </aside>
            </div>
          </>
        )}
      </main>
      <footer>
        Built for deliberate practice.{' '}
        <span>Private history · Versioned questions · Honest evidence</span>
      </footer>
    </div>
  );
}
