'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudyAction, StudyItem, StudyState } from '@/lib/contracts/study';
import { confidenceSchema } from '@/lib/contracts/study';
import {
  readDraft,
  removeDraft,
  writeDraft,
  type DraftSnapshot,
} from '@/lib/client/drafts';
import { readState } from '@/lib/client/api';
import { formatActiveTime } from '@/lib/domain/timing';

type CheckpointAction = Extract<
  StudyAction,
  { action: 'checkpoint' }
>['timingAction'];
type Props = {
  item: StudyItem;
  state: StudyState;
  deviceId: string;
  recoveryWriterId?: string;
  change: (action: StudyAction) => Promise<StudyState>;
  updated: (state: StudyState) => void;
  leave: () => void;
};
const sameAnswer = (draft: DraftSnapshot, item: StudyItem) =>
  draft.answer === item.answer_text &&
  draft.confidence === item.confidence &&
  draft.assisted === item.assisted;

export function AnswerEditor({
  item,
  state,
  deviceId,
  recoveryWriterId,
  change,
  updated,
  leave,
}: Props) {
  const [draft, setDraft] = useState<DraftSnapshot | null>(null);
  const current = useRef<DraftSnapshot | null>(null);
  const cloud = useRef(item);
  const [initial] = useState(item);
  const [acknowledgedItem, setAcknowledgedItem] = useState(item);
  const [status, setStatus] = useState('Loading local recovery snapshot…');
  const [conflict, setConflict] = useState<StudyItem | null>(null);
  const blocked = useRef(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState(false);
  const [now, setNow] = useState(0);
  const localWrites = useRef(Promise.resolve());
  const mounted = useRef(true);
  const saveSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [serverOffset, setServerOffset] = useState(
    () => Date.parse(state.serverNow) - Date.now(),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const persist = useCallback((value: DraftSnapshot) => {
    localWrites.current = localWrites.current
      .catch(() => {})
      .then(async () => {
        if (!mounted.current) return;
        await writeDraft(value);
        if (mounted.current) {
          try {
            sessionStorage.setItem('sweprep-tab', value.writerId);
          } catch {}
        }
      });
    localWrites.current
      .then(() => setLocalError(false))
      .catch(() => setLocalError(true));
    return localWrites.current;
  }, []);

  const accept = useCallback((value: DraftSnapshot) => {
    current.current = value;
    setDraft(value);
  }, []);

  useEffect(() => {
    let cancelled = false;
    readDraft(state.userId, initial.id, deviceId, recoveryWriterId)
      .then(async (saved) => {
        if (cancelled) return;
        const local = saved ? { ...saved, writerId: deviceId } : null;
        const value: DraftSnapshot = local ?? {
          userId: state.userId,
          itemId: initial.id,
          questionId: initial.question_version_id,
          writerId: deviceId,
          baseVersion: initial.version,
          answer: initial.answer_text,
          confidence: initial.confidence,
          assisted: initial.assisted,
          updatedAt: initial.saved_at,
          submission: null,
          timingDisconnected: false,
        };
        await persist(value).catch(() => {});
        if (cancelled) return;
        accept(value);
        if (
          local &&
          local.baseVersion !== initial.version &&
          !sameAnswer(local, initial) &&
          !local.submission
        ) {
          blocked.current = true;
          setIsBlocked(true);
          setConflict(initial);
          setStatus('Sync conflict. Both versions are preserved.');
        } else {
          setStatus(
            sameAnswer(value, initial)
              ? 'Saved to cloud'
              : 'Saved on this device only',
          );
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLocalError(true);
        accept({
          userId: state.userId,
          itemId: initial.id,
          questionId: initial.question_version_id,
          writerId: deviceId,
          baseVersion: initial.version,
          answer: initial.answer_text,
          confidence: initial.confidence,
          assisted: initial.assisted,
          updatedAt: initial.saved_at,
          submission: null,
          timingDisconnected: false,
        });
        setStatus('Cloud copy loaded. Local recovery storage is unavailable.');
      });
    return () => {
      cancelled = true;
    };
  }, [accept, deviceId, initial, persist, recoveryWriterId, state.userId]);

  const save = useCallback(
    async (action: CheckpointAction = 'save') => {
      const value = current.current;
      if (
        !value ||
        value.submission ||
        pending.current ||
        (blocked.current && action !== 'takeover')
      )
        return false;
      if (!navigator.onLine) {
        setStatus('Saved on this device only · offline; timing is paused');
        return false;
      }
      pending.current = true;
      setBusy(true);
      setStatus('Saving to cloud…');
      try {
        const next = await change({
          action: 'checkpoint',
          itemId: item.id,
          version: cloud.current.version,
          answer: value.answer,
          confidence: value.confidence,
          assisted: value.assisted,
          deviceId,
          timingAction: value.timingDisconnected
            ? action === 'takeover' || action === 'resume'
              ? 'takeover'
              : 'disconnect'
            : action,
        });
        const acknowledged = next.items.find((entry) => entry.id === item.id);
        if (!acknowledged) throw new Error('UNAVAILABLE');
        cloud.current = acknowledged;
        setAcknowledgedItem(acknowledged);
        setServerOffset(Date.parse(next.serverNow) - Date.now());
        const latest = current.current ?? value;
        const preserved = {
          ...latest,
          baseVersion: acknowledged.version,
          assisted: latest.assisted || acknowledged.assisted,
          timingDisconnected: false,
        };
        accept(preserved);
        await persist(preserved).catch(() => {});
        blocked.current = false;
        setIsBlocked(false);
        setConflict(null);
        setStatus(
          sameAnswer(preserved, acknowledged)
            ? 'Saved to cloud'
            : 'Saved on this device only',
        );
        return true;
      } catch (error) {
        const code = error instanceof Error ? error.message : 'UNAVAILABLE';
        if (code === 'SYNC_CONFLICT' || code === 'TIMER_OWNED') {
          blocked.current = true;
          setIsBlocked(true);
          const fresh = await readState().catch(() => null);
          const remote = fresh?.items.find((entry) => entry.id === item.id);
          if (fresh) updated(fresh);
          if (remote) {
            cloud.current = remote;
            setAcknowledgedItem(remote);
            const latest = current.current;
            if (latest && sameAnswer(latest, remote)) {
              const matching = { ...latest, baseVersion: remote.version };
              accept(matching);
              await persist(matching).catch(() => {});
              blocked.current = false;
              setIsBlocked(false);
              setConflict(null);
              setStatus(
                code === 'TIMER_OWNED'
                  ? 'Saved to cloud. Another tab or device owns the timer; take over explicitly to continue timing.'
                  : 'Saved to cloud',
              );
              return false;
            }
            setConflict(remote);
          }
          setStatus(
            code === 'TIMER_OWNED'
              ? 'Another tab or device owns the timer. Choose a copy, then take over explicitly.'
              : 'Sync conflict. Choose which copy to keep; neither was overwritten.',
          );
        } else {
          const latest = current.current;
          if (latest) {
            const offline = { ...latest, timingDisconnected: true };
            accept(offline);
            void persist(offline).catch(() => {});
          }
          setStatus(
            'Cloud save not acknowledged. Your device copy is preserved; reconnect and retry.',
          );
        }
        return false;
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [accept, change, deviceId, item.id, persist, updated],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      const value = current.current;
      if (
        value &&
        !value.submission &&
        !blocked.current &&
        (!sameAnswer(value, cloud.current) ||
          (!cloud.current.paused && cloud.current.lease_device === deviceId))
      )
        void save();
    }, 10000);
    const offline = () => {
      const value = current.current;
      if (value) {
        const next = { ...value, timingDisconnected: true };
        accept(next);
        void persist(next).catch(() => {});
      }
      setStatus('Saved on this device only · offline; timing is paused');
    };
    const online = () => {
      void save();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        current.current &&
        (!sameAnswer(current.current, cloud.current) ||
          current.current.submission)
      )
        event.preventDefault();
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', beforeUnload);
    const display = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(timer);
      clearInterval(display);
      if (saveSoon.current) clearTimeout(saveSoon.current);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [accept, deviceId, persist, save]);

  function edit(
    fields: Partial<Pick<DraftSnapshot, 'answer' | 'confidence' | 'assisted'>>,
  ) {
    if (!current.current || current.current.submission) return;
    const value = {
      ...current.current,
      ...fields,
      updatedAt: new Date().toISOString(),
    };
    accept(value);
    setStatus('Saving on this device…');
    void persist(value)
      .then(() => {
        if (current.current?.updatedAt === value.updatedAt)
          setStatus('Saved on this device only');
      })
      .catch(() =>
        setStatus(
          'Draft is not saved locally. Use Save to cloud before leaving.',
        ),
      );
    if (saveSoon.current) clearTimeout(saveSoon.current);
    saveSoon.current = setTimeout(() => {
      void save();
    }, 2000);
  }

  async function submit() {
    let value = current.current;
    if (!value || pending.current || blocked.current || !navigator.onLine)
      return;
    if (value.timingDisconnected && !value.submission) {
      if (!(await save('disconnect'))) return;
      value = current.current;
      if (!value) return;
    }
    const action = value.submission ?? {
      action: 'submit' as const,
      itemId: item.id,
      version: cloud.current.version,
      questionId: item.question_version_id,
      answer: value.answer,
      confidence: value.confidence,
      assisted: value.assisted,
      deviceId,
      key: crypto.randomUUID(),
    };
    if (
      !value.submission &&
      !window.confirm(
        'Submit this answer? The submitted answer cannot be edited.',
      )
    )
      return;
    const frozen = { ...value, submission: action };
    accept(frozen);
    try {
      await persist(frozen);
    } catch {
      setStatus(
        'Local storage unavailable. Submission still uses one key while this tab stays open.',
      );
    }
    pending.current = true;
    setBusy(true);
    try {
      await change(action);
      await localWrites.current.catch(() => {});
      await removeDraft(state.userId, item.id).catch(() => {});
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (
        ['SYNC_CONFLICT', 'TIMER_OWNED', 'ALREADY_SUBMITTED'].includes(code)
      ) {
        const fresh = await readState().catch(() => null);
        if (fresh) updated(fresh);
        if (fresh?.attempts.some((entry) => entry.item_id === item.id)) {
          await removeDraft(state.userId, item.id).catch(() => {});
        } else {
          const unfrozen = { ...frozen, submission: null };
          accept(unfrozen);
          void persist(unfrozen).catch(() => {});
          blocked.current = true;
          setIsBlocked(true);
          const remote = fresh?.items.find((entry) => entry.id === item.id);
          if (remote) {
            cloud.current = remote;
            setAcknowledgedItem(remote);
            setConflict(remote);
          }
          setStatus(
            'Submission was not accepted. Resolve the cloud conflict before submitting.',
          );
        }
      } else {
        setStatus(
          'Submission is not confirmed. Retry the exact same submission; do not create a new answer.',
        );
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function chooseCopy(useLocal: boolean) {
    if (!current.current || !conflict) return;
    cloud.current = conflict;
    setAcknowledgedItem(conflict);
    const next = {
      ...current.current,
      baseVersion: conflict.version,
      ...(useLocal
        ? {}
        : {
            answer: conflict.answer_text,
            confidence: conflict.confidence,
            assisted: conflict.assisted,
          }),
    };
    accept(next);
    await persist(next).catch(() => {});
    blocked.current = false;
    setIsBlocked(false);
    setConflict(null);
    if (useLocal) await save('takeover');
    else
      setStatus('Cloud copy selected. Resume to take over timing if needed.');
  }

  if (!draft) return <p role="status">{status}</p>;
  const authoritative = acknowledgedItem;
  const serverNow = now ? now + serverOffset : Date.parse(state.serverNow);
  const running =
    !authoritative.paused &&
    authoritative.lease_device === deviceId &&
    !draft.timingDisconnected &&
    serverNow < Date.parse(authoritative.lease_until ?? '');
  const provisionalMs = running
    ? Math.max(
        0,
        Math.min(
          30000,
          serverNow - Date.parse(authoritative.last_ack_at ?? ''),
        ),
      )
    : 0;
  return (
    <section className="editor" aria-labelledby="answer-title">
      <div className="section-heading">
        <h3 id="answer-title">Your reasoning</h3>
        <span className="timer" aria-label="Question active time">
          {formatActiveTime(authoritative.active_ms + provisionalMs)}{' '}
          <small>
            {running ? 'active · provisional' : 'paused / lease inactive'}
          </small>
        </span>
      </div>
      <p className="fine-print">
        Explain what happens, why it happens, and what you would change. There
        is no time limit.
      </p>
      <label className="sr-only" htmlFor="answer">
        Your answer
      </label>
      <textarea
        id="answer"
        value={draft.answer}
        maxLength={12000}
        rows={9}
        disabled={Boolean(draft.submission)}
        onChange={(event) => edit({ answer: event.target.value })}
        placeholder="Start with the key observation…"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="answer-meta">
        <span>{draft.answer.length.toLocaleString()} / 12,000 characters</span>
        <span>Ctrl / ⌘ + Enter to submit with confirmation</span>
      </div>
      <div className="answer-options">
        <div>
          <label htmlFor="confidence">Confidence before feedback</label>
          <select
            id="confidence"
            value={draft.confidence}
            disabled={Boolean(draft.submission)}
            onChange={(event) =>
              edit({ confidence: confidenceSchema.parse(event.target.value) })
            }
          >
            <option value="guess">Guess</option>
            <option value="unsure">Unsure</option>
            <option value="fairly_sure">Fairly sure</option>
            <option value="certain">Certain</option>
          </select>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.assisted}
            disabled={draft.assisted || Boolean(draft.submission)}
            onChange={() => edit({ assisted: true })}
          />
          I used a definition, hint, or outside help.
        </label>
      </div>
      <div className="save-state" role="status" aria-live="polite">
        <span
          className={
            status === 'Saved to cloud' ? 'status-dot saved' : 'status-dot'
          }
        />
        {status}
      </div>
      <p className="fine-print">
        Last cloud acknowledgment:{' '}
        {new Date(authoritative.saved_at).toLocaleTimeString()} · version{' '}
        {authoritative.version}. Cross-device resume includes acknowledged saves
        only.
      </p>
      {localError && (
        <p role="alert" className="notice warning">
          Local recovery storage is unavailable. If a cloud save also fails,
          your answer exists only in this open tab.
        </p>
      )}
      {conflict && (
        <div className="conflict notice warning">
          <h4>Choose a draft to preserve</h4>
          <div className="conflict-copies">
            <div>
              <strong>This device</strong>
              <pre>{draft.answer || '(empty draft)'}</pre>
              <p>
                Confidence: {draft.confidence} ·{' '}
                {draft.assisted ? 'Assisted' : 'Unassisted'}
              </p>
            </div>
            <div>
              <strong>Cloud · version {conflict.version}</strong>
              <pre>{conflict.answer_text || '(empty draft)'}</pre>
              <p>
                Confidence: {conflict.confidence} ·{' '}
                {conflict.assisted ? 'Assisted' : 'Unassisted'}
              </p>
            </div>
          </div>
          <p>
            Choosing this device explicitly replaces the cloud copy and takes
            over the timer. Copy any text you want to combine first.
          </p>
          <div className="actions">
            <button
              className="secondary"
              onClick={() => void chooseCopy(false)}
            >
              Use cloud copy
            </button>
            <button className="secondary" onClick={() => void chooseCopy(true)}>
              Keep this device copy & take over
            </button>
          </div>
        </div>
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={busy || isBlocked || !draft.answer.trim()}
          onClick={() => void submit()}
        >
          {draft.submission ? 'Retry exact submission' : 'Submit answer'}{' '}
          <span aria-hidden="true">→</span>
        </button>
        <button
          className="secondary"
          disabled={busy || Boolean(draft.submission) || Boolean(conflict)}
          onClick={() => void save('save')}
        >
          Save to cloud
        </button>
        <button
          className="quiet"
          disabled={busy || Boolean(draft.submission) || Boolean(conflict)}
          onClick={() =>
            void save(
              running
                ? 'pause'
                : authoritative.lease_device &&
                    authoritative.lease_device !== deviceId
                  ? 'takeover'
                  : 'resume',
            )
          }
        >
          {running
            ? 'Pause'
            : authoritative.lease_device &&
                authoritative.lease_device !== deviceId
              ? 'Take over timer'
              : 'Resume timer'}
        </button>
        <button
          className="quiet"
          disabled={busy || Boolean(draft.submission) || Boolean(conflict)}
          onClick={async () => {
            if (await save('pause')) leave();
          }}
        >
          Save, pause & view history
        </button>
      </div>
      <p className="fine-print">
        Only acknowledged online time enters totals. A lost connection or
        expired lease can undercount the last seconds; offline edits do not add
        time.
      </p>
    </section>
  );
}
