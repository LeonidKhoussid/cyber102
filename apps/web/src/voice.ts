import { useEffect, useRef, useState } from 'react';
import { request } from './http.ts';

const recordingTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const maxBytes = 1_048_576;
const previewInterval = 4000;
const maxPreviews = 4;
type VoiceStatus = 'idle' | 'permission' | 'recording' | 'transcribing';
type Capture = {
  controller: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  previewRecorder?: MediaRecorder;
  timer?: number;
  previewTimer?: number;
  previewRequest?: AbortController;
};

function stopPreviews(capture: Capture) {
  window.clearInterval(capture.previewTimer);
  capture.previewRequest?.abort();
  const recorder = capture.previewRecorder;
  capture.previewRecorder = undefined;
  if (recorder?.state === 'recording') recorder.stop();
}

function release(capture: Capture) {
  window.clearTimeout(capture.timer);
  stopPreviews(capture);
  capture.stream?.getTracks().forEach(track => track.stop());
}

export function useVoice(onTranscript: (text: string) => void) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const active = useRef<Capture | null>(null);

  useEffect(() => () => {
    if (!active.current) return;
    active.current.controller.abort();
    release(active.current);
    active.current = null;
  }, []);

  function cancel() {
    const capture = active.current;
    active.current = null;
    if (capture) {
      capture.controller.abort();
      release(capture);
    }
    setStatus('idle');
    setError('');
    setPreview('');
  }

  function stop() {
    const capture = active.current;
    if (capture?.recorder?.state !== 'recording') return;
    stopPreviews(capture);
    capture.recorder.stop();
    setStatus('transcribing');
  }

  async function start() {
    if (active.current) return;
    setError('');
    setPreview('');
    const mimeType = typeof MediaRecorder === 'undefined' ? undefined : recordingTypes.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
      setError('Микрофон доступен в поддерживаемом браузере на HTTPS или localhost.');
      return;
    }
    const capture: Capture = { controller: new AbortController() };
    active.current = capture;
    setStatus('permission');
    try {
      capture.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (capture.controller.signal.aborted) {
        release(capture);
        return;
      }
      const recorder = new MediaRecorder(capture.stream, { mimeType, audioBitsPerSecond: 64_000 });
      const audioType = (recorder.mimeType || mimeType).split(';', 1)[0];
      const parts: Blob[] = [];
      let latestPreview = '';
      let previews = 0;
      capture.recorder = recorder;

      async function transcribe(audioParts: Blob[], signal: AbortSignal) {
        const audio = new Blob(audioParts, { type: audioType });
        if (!audio.size) throw new Error('Запись пустая. Попробуйте ещё раз.');
        if (audio.size > maxBytes) throw new Error('Запись слишком большая. Попробуйте сказать вопрос короче.');
        return request<{ text: string }>('/api/v1/transcribe', {
          method: 'POST', headers: { 'Content-Type': audioType }, body: audio,
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
      }

      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };

      function recordPreview(stream: MediaStream) {
        // Closing a separate recording makes each preview a valid audio file.
        // The main recorder keeps a continuous copy for the final transcript.
        const clip = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
        const audioParts: Blob[] = [];
        clip.ondataavailable = event => { if (event.data.size) audioParts.push(event.data); };
        clip.onstop = async () => {
          if (active.current !== capture || recorder.state !== 'recording' ||
              !capture.previewRecorder || capture.previewRequest || !audioParts.length) return;
          const previewRequest = new AbortController();
          capture.previewRequest = previewRequest;
          try {
            const result = await transcribe(audioParts, previewRequest.signal);
            if (active.current === capture && !previewRequest.signal.aborted) {
              latestPreview = [latestPreview, result.text].filter(Boolean).join(' ');
              setPreview(latestPreview);
            }
          } catch {
            // A silent clip or a failed preview can still yield a final transcript.
          } finally {
            capture.previewRequest = undefined;
          }
        };
        clip.start();
        return clip;
      }
      recorder.onerror = () => {
        if (active.current !== capture) return;
        cancel();
        setError('Не удалось записать звук. Проверьте микрофон и попробуйте снова.');
      };
      recorder.onstop = async () => {
        release(capture);
        if (active.current !== capture) return;
        setStatus('transcribing');
        try {
          const result = await transcribe(parts, capture.controller.signal);
          if (active.current === capture) onTranscript(result.text);
        } catch (error) {
          if (active.current === capture) {
            if (latestPreview) onTranscript(latestPreview);
            setError(latestPreview ? 'Сохранена только часть записи. Проверьте и дополните текст.'
              : error instanceof Error ? error.message : 'Не удалось распознать запись.');
          }
        } finally {
          if (active.current === capture) {
            active.current = null;
            setPreview('');
            setStatus('idle');
          }
        }
      };
      const stream = capture.stream;
      recorder.start();
      setStatus('recording');
      capture.timer = window.setTimeout(stop, 25_000);
      try {
        capture.previewRecorder = recordPreview(stream);
        capture.previewTimer = window.setInterval(() => {
          const clip = capture.previewRecorder;
          if (clip?.state !== 'recording' || capture.previewRequest || previews >= maxPreviews) return;
          try {
            capture.previewRecorder = recordPreview(stream);
            previews++;
          } catch {
            stopPreviews(capture);
          }
          if (clip.state === 'recording') clip.stop();
        }, previewInterval);
      } catch {
        // Some browsers only support one active recorder per stream.
      }
    } catch (error) {
      if (active.current !== capture) return;
      cancel();
      setError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Разрешите доступ к микрофону в настройках браузера.'
        : 'Не удалось включить микрофон. Проверьте подключение и попробуйте снова.');
    }
  }

  return { status, error, preview, start, stop, cancel };
}
