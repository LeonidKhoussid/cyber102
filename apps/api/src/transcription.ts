export const audioTypes = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
} as const;

export type AudioType = keyof typeof audioTypes;
export type Transcribe = (audio: Buffer, type: AudioType) => Promise<string>;

export function transcriber(environment: NodeJS.ProcessEnv): Transcribe | undefined {
  const key = environment.OPENAI_API_KEY || environment.TIMEWEB_API_KEY;
  if (!key) return;
  const openai = Boolean(environment.OPENAI_API_KEY);
  const base = openai ? 'https://api.openai.com/v1' : (environment.BASE_URL || 'https://api.timeweb.ai/v1');
  const endpoint = new URL('audio/transcriptions', base.replace(/\/?$/, '/'));
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('Audio transcription requires an HTTPS endpoint without embedded credentials.');
  }
  return async (audio, type) => {
    const form = new FormData();
    form.set('model', openai ? 'whisper-1' : 'openai/gpt-4o-mini-transcribe');
    form.set('file', new Blob([new Uint8Array(audio)], { type }), `question.${audioTypes[type]}`);
    form.set('language', 'ru');
    form.set('response_format', 'json');
    const response = await fetch(endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${key}` },
      body: form, signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 400 || response.status === 422) throw new UnreadableAudio();
      throw new Error('Transcription provider unavailable.');
    }
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== 'string') throw new Error('Invalid transcription response.');
    const transcript = result.text.trim();
    if (!transcript || transcript.length > 1200) throw new UnreadableAudio();
    return transcript;
  };
}

export class UnreadableAudio extends Error {}
