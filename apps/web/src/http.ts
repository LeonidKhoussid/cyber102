import { useEffect, useState } from 'react';

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const unavailable = 'Сервис временно недоступен. Попробуйте ещё раз.';
  const response = await fetch(url, options).catch(() => { throw new Error(unavailable); });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(body?.message ?? unavailable);
  }
  if (response.status === 204) return undefined as T;
  return response.json().catch(() => { throw new Error(unavailable); });
}

export function useData<T>(url: string) {
  const [result, setResult] = useState<{ data?: T; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({});
    request<T>(url, { signal: controller.signal })
      .then(data => setResult({ data }))
      .catch(error => {
        if (!controller.signal.aborted) setResult({ error: error.message });
      });
    return () => controller.abort();
  }, [url, attempt]);
  return { ...result, retry: () => setAttempt(attempt + 1) };
}
