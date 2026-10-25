import type { StudyState } from '@/lib/contracts/study';

export function Grade({
  state,
  attemptId,
  retry,
  busy,
}: {
  state: StudyState;
  attemptId: string;
  retry: () => void;
  busy: boolean;
}) {
  const attempt = state.attempts.find((value) => value.id === attemptId);
  const job = state.jobs.find((value) => value.attempt_id === attemptId);
  const selection = state.selections
    .filter((value) => value.attempt_id === attemptId)
    .at(-1);
  const grade = state.grades.find((value) => value.id === selection?.grade_id);
  const revisions = state.grades
    .filter((value) => value.attempt_id === attemptId)
    .sort((a, b) => a.generation - b.generation);
  if (!attempt || !job) return null;
  const pending = ['pending', 'grading', 'retry_wait'].includes(job.state);
  return (
    <section className="grade-section" aria-labelledby="grade-title">
      <div className="section-heading">
        <h3 id="grade-title">Answer saved. History preserved.</h3>
        <span className="tag">{job.state.replace('_', ' ')}</span>
      </div>
      <p className="fine-print">
        Submitted{' '}
        {new Date(attempt.submitted_at).toLocaleString(undefined, {
          timeZone: state.timezone,
        })}{' '}
        · {attempt.source === 'first' ? 'First attempt' : 'Review'} ·{' '}
        {attempt.assisted ? 'Assisted' : 'Unassisted'} ·{' '}
        {Math.round(attempt.active_ms / 1000)}s acknowledged active time
      </p>
      <div
        role="status"
        aria-live="polite"
        className={job.state === 'failed' ? 'notice warning' : 'notice'}
      >
        {pending
          ? 'Your answer is safely stored. Grading is pending; the recovery runner works independently of this tab.'
          : job.state === 'failed'
            ? `No grade was produced (${job.error_code}). This is not a wrong answer. Retry grading without resubmitting.`
            : job.state === 'uncertain'
              ? 'This grading generation is unscored. A previous valid score, if present, remains effective.'
              : 'Grading is complete. No readiness claim is made.'}
      </div>
      {grade && (
        <div className="grade-result">
          {grade.simulated && (
            <strong className="simulation-label">
              Simulated grading / not readiness evidence
            </strong>
          )}
          {grade.details.outcome === 'scored' ? (
            <>
              <div className="score-row">
                <span className="score">
                  {grade.score}
                  <small>/ 5</small>
                </span>
                <div>
                  <strong>
                    {grade.simulated
                      ? 'Demonstration score'
                      : grade.passed
                        ? 'Meets this question’s pass rule'
                        : 'Below this question’s pass rule'}
                  </strong>
                  <p>{grade.details.explanation}</p>
                </div>
              </div>
              {(
                [
                  ['Strengths', grade.details.correctClaims],
                  ['Missing claims', grade.details.missingClaims],
                  ['Incorrect claims', grade.details.incorrectClaims],
                ] as const
              )
                .filter(([, values]) => values.length)
                .map(([title, values]) => (
                  <div key={title}>
                    <h4>{title}</h4>
                    <ul>
                      {values.map((value, i) => (
                        <li key={i}>{value}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              <h4>Reference reasoning</h4>
              <p>{grade.details.idealAnswer}</p>
            </>
          ) : (
            <p>{grade.details.reason}</p>
          )}
          <p className="fine-print">
            Rubric {grade.rubric_version} · {grade.grader_version} ·{' '}
            {grade.model} · {grade.prompt_version} · {grade.validator_version}
          </p>
        </div>
      )}
      {!pending && (
        <button className="secondary" disabled={busy} onClick={retry}>
          {grade ? 'Request a grading revision' : 'Retry grading'}
        </button>
      )}
      <details>
        <summary>
          Submitted answer & immutable revisions ({revisions.length})
        </summary>
        <pre className="answer-record">{attempt.answer_text}</pre>
        {revisions.map((value) => (
          <p className="fine-print" key={value.id}>
            Generation {value.generation}: {value.outcome}
            {value.score !== null ? ` · ${value.score}/5` : ''}
            {value.id === grade?.id ? ' · effective' : ''}
            {value.simulated ? ' · simulated' : ''}
          </p>
        ))}
      </details>
    </section>
  );
}
