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

/**
 * Family photos (a flyer, a school notice, a handwritten list): the readable
 * text plus the events and items in it, so the Family chat can turn "add this to
 * the calendar" into an event on this turn or a later one. Saved as its own
 * history row with role "photo": quotable for an event's or item's details,
 * never as anyone's request (src/family-turn-manifest.ts).
 */
export async function transcribePhotoForFamily(image: { mimetype: string; base64: string }): Promise<string | null> {
  try {
    const res = await createOpenAIResponse({
      model: OPENAI_ROUTER_MODEL,
      instructions: 'Transcribe this photo for a family assistant. First the readable text, as written (keep dates, times, places, names, prices exactly). Then, if there are any, one line per event as "Event: <title> | <date> | <time> | <place>" and one line per item as "Item: <item>". Plain text, no commentary. If nothing is readable, describe it in one line.',
      input: [{ role: 'user', content: [
        { type: 'input_image', image_url: `data:${image.mimetype};base64,${image.base64}` },
        { type: 'input_text', text: 'Transcribe.' },
      ] }],
      maxOutputTokens: 700,
      reasoningEffort: 'none',
    });
    const text = openAITextFromResponse(res).trim();
    return text ? text.slice(0, 3000) : null;
  } catch (err) {
    console.warn('[photo-caption] family transcription failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
