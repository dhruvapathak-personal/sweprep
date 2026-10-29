export const providerBaseUrl = 'https://api.openai.com/v1';

export function structuredRequest(
  task: {
    input: string;
    instructions: string;
    jsonSchema: Record<string, unknown>;
  },
  model: string,
  name: 'technical_grade' | 'content_qualification',
) {
  return {
    model,
    instructions: task.instructions,
    input: task.input,
    store: false as const,
    max_output_tokens: 3000,
    reasoning: { effort: 'none' as const },
    text: {
      format: {
        type: 'json_schema' as const,
        name,
        strict: true as const,
        schema: task.jsonSchema,
      },
    },
  };
}
