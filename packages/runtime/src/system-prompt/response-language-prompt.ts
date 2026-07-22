/**
 * Stable language policy shared by every interactive host.
 *
 * The model can infer the language of the latest user message more reliably
 * than a client-side locale or a small language detector. Keeping this in the
 * durable system prompt also covers streamed narration and final answers
 * without rewriting model deltas in the UI.
 */
export function buildResponseLanguagePromptFragment(): string {
  return [
    'Response language:',
    "- Write all user-visible assistant-authored prose in the same predominant natural language as the user's latest request. This includes progress updates, visible reasoning summaries, questions, and the final answer.",
    '- If the user explicitly requests a different language, follow that request instead.',
    '- If the latest request mixes languages, use the language of its main instruction.',
    '- Keep code, commands, paths, identifiers, quotations, and raw tool output in their original form unless the user asks for translation.',
  ].join('\n');
}
