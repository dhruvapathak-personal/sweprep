import type { StudyState } from '@/lib/contracts/study';

export function Question({
  question,
}: {
  question: StudyState['questions'][number];
}) {
  return (
    <section className="question" aria-labelledby="question-title">
      <div className="question-meta">
        <span className="eyebrow">{question.skill}</span>
        <span className="tag">Question version {question.version}</span>
      </div>
      <h2 id="question-title">{question.title}</h2>
      {question.content_blocks.map((block, index) =>
        block.type === 'text' ? (
          <p key={index}>{block.text}</p>
        ) : (
          <div className="code-block" key={index}>
            <div className="code-label">
              {block.language === 'cpp' ? 'C++20' : block.language}
            </div>
            <pre tabIndex={0} aria-label={`${block.language} question code`}>
              <code>{block.text}</code>
            </pre>
          </div>
        ),
      )}
      {question.content_review === 'candidate' && (
        <p className="fine-print">
          Candidate question · awaiting human content review. Difficulty is not
          calibrated.
        </p>
      )}
    </section>
  );
}
