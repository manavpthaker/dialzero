import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { isModuleOn } from './modules.js';

const exec = promisify(execFile);

// Local, on-device speech-to-text via whisper.cpp + ffmpeg.
// Audio never leaves the machine. Both binaries come from `brew install whisper-cpp ffmpeg`.
const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || join(homedir(), '.cache/whisper/ggml-small.en.bin');

let warnedMissing = false;

export function transcriptionAvailable(): boolean {
  // `voice-notes` module: on by itself once whisper-cli, ffmpeg and the model
  // are installed; MODULES_OFF=voice-notes switches it off.
  if (!isModuleOn('voice-notes')) return false;
  const ok = existsSync(WHISPER_BIN) && existsSync(FFMPEG_BIN) && existsSync(WHISPER_MODEL);
  if (!ok && !warnedMissing) {
    warnedMissing = true;
    console.warn(
      '[transcribe] Voice transcription disabled. Need all of:\n' +
        `  whisper-cli: ${existsSync(WHISPER_BIN) ? 'ok' : `MISSING (${WHISPER_BIN})`}\n` +
        `  ffmpeg:      ${existsSync(FFMPEG_BIN) ? 'ok' : `MISSING (${FFMPEG_BIN})`}\n` +
        `  model:       ${existsSync(WHISPER_MODEL) ? 'ok' : `MISSING (${WHISPER_MODEL})`}\n` +
        '  Fix: brew install whisper-cpp ffmpeg && \\\n' +
        '       curl -L -o ~/.cache/whisper/ggml-small.en.bin \\\n' +
        '       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin'
    );
  }
  return ok;
}

/**
 * Transcribe an audio file (e.g. an iMessage voice memo, typically .caf) to text.
 * Transcodes to 16kHz mono WAV via ffmpeg, then runs whisper.cpp locally.
 * Returns the transcript, or null on any failure (missing tools, bad audio, empty result).
 */
export async function transcribeAudio(
  filePath: string,
  options: { privacySafeLogs?: boolean } = {},
): Promise<string | null> {
  if (!transcriptionAvailable()) return null;
  if (!existsSync(filePath)) return null;

  const workDir = mkdtempSync(join(tmpdir(), 'assistant-stt-'));
  const wavPath = join(workDir, 'audio.wav');

  try {
    // whisper.cpp wants 16kHz mono 16-bit PCM WAV.
    await exec(FFMPEG_BIN, [
      '-y',
      '-i', filePath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      wavPath,
    ]);

    if (!existsSync(wavPath)) return null;

    // -nt: no timestamps, -np: no progress prints. Transcript goes to stdout.
    const { stdout } = await exec(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', wavPath,
      '-nt',
      '-np',
    ]);

    const transcript = stdout.replace(/\s+/g, ' ').trim();
    return transcript.length > 0 ? transcript : null;
  } catch (err) {
    if (options.privacySafeLogs) {
      console.error('[transcribe] Family voice transcription failed');
    } else {
      console.error('[transcribe] Failed:', err instanceof Error ? err.message : err);
    }
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
