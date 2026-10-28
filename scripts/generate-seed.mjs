import { readFileSync, writeFileSync } from 'node:fs';

const content = JSON.parse(
  readFileSync('tests/fixtures/candidate-content.json', 'utf8'),
);
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const skills = [
  ['cpp', null, 'C++'],
  ['cpp.lifetime', 'cpp', 'Object lifetime'],
  ['cpp.memory-ordering', 'cpp', 'Memory ordering'],
  ['python', null, 'Python'],
  ['python.async', 'python', 'Async execution'],
  ['distributed-systems', null, 'Distributed systems'],
  ['distributed-systems.idempotency', 'distributed-systems', 'Idempotency'],
  ['architecture', null, 'Architecture'],
  ['architecture.trade-offs', 'architecture', 'Trade-offs'],
];
const skillIds = [
  'cpp.lifetime',
  'cpp.memory-ordering',
  'python.async',
  'distributed-systems.idempotency',
  'architecture.trade-offs',
];
const statements = [
  ...skills.map(
    ([id, parent, name]) =>
      `insert into public.curriculum_skills(id,parent_id,name) values(${literal(id)},${parent ? literal(parent) : 'null'},${literal(name)});`,
  ),
  ...content.questions.flatMap((question, index) => [
    `insert into public.question_versions(id,question_id,version,title,skill,skill_id,content_blocks,content_review,prompt_version) values(${literal(question.id)},${literal(question.questionId)},1,${literal(question.title)},${literal(question.skill)},${literal(skillIds[index])},${literal(JSON.stringify(question.blocks))}::jsonb,'candidate','candidate-content-v1');`,
    `insert into private.rubrics(question_version_id,version,pass_score,required_claims,reference_answer) values(${literal(question.id)},'rubric-v1',${question.rubric.passScore},array[${question.rubric.requiredClaims.map(literal).join(',')}],${literal(question.rubric.referenceAnswer)});`,
  ]),
];
writeFileSync('supabase/seed.sql', statements.join('\n') + '\n');
