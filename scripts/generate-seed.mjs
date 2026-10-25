import { readFileSync, writeFileSync } from 'node:fs';

const content = JSON.parse(
  readFileSync('tests/fixtures/candidate-content.json', 'utf8'),
);
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const statements = content.questions.flatMap((question) => [
  `insert into public.question_versions(id,question_id,version,title,skill,content_blocks,content_review,prompt_version) values(${literal(question.id)},${literal(question.questionId)},1,${literal(question.title)},${literal(question.skill)},${literal(JSON.stringify(question.blocks))}::jsonb,'candidate','candidate-content-v1');`,
  `insert into private.rubrics(question_version_id,version,pass_score,required_claims,reference_answer) values(${literal(question.id)},'rubric-v1',${question.rubric.passScore},array[${question.rubric.requiredClaims.map(literal).join(',')}],${literal(question.rubric.referenceAnswer)});`,
]);
writeFileSync('supabase/seed.sql', statements.join('\n') + '\n');
