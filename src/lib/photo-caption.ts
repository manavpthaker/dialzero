// One line saying what a photo showed ("PSE&G bill, $142.18 due Oct 14"), saved
// next to the message in history. Only the text of a message is kept, so
// without this "pay that one" an hour later has nothing to refer to.

import { createOpenAIResponse, openAITextFromResponse, OPENAI_ROUTER_MODEL } from './openai.js';

export async function captionPhoto(image: { mimetype: string; base64: string }): Promise<string | null> {
  try {
    const res = await createOpenAIResponse({
      model: OPENAI_ROUTER_MODEL,
      instructions: 'Describe this photo in one short line for a personal assistant\'s notes: what it is and the key details someone would act on (who it\'s from, amounts, dates, deadlines, reference numbers). No preamble.',
      input: [{ role: 'user', content: [
        { type: 'input_image', image_url: `data:${image.mimetype};base64,${image.base64}` },
        { type: 'input_text', text: 'What is this?' },
      ] }],
      maxOutputTokens: 120,
      reasoningEffort: 'none',
    });
    const line = openAITextFromResponse(res).replace(/\s+/g, ' ').trim();
    return line ? line.slice(0, 240) : null;
  } catch (err) {
    console.warn('[photo-caption] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
