import { useState, useCallback, useEffect } from "react";
export async function api(url: string, options: RequestInit = {}) {
  const r = await fetch("/api" + url, {
    ...options,
    headers: {
      "X-MK-Request": "1",
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
export const send = (url: string, body?: unknown, method = "POST") =>
  api(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export function useLoad<T>(fn: () => Promise<T>, deps: any[], interval = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setData(await fn());
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, deps);
  useEffect(() => {
    setData(null);
    void reload();
    if (interval) {
      const id = setInterval(reload, interval);
      return () => clearInterval(id);
    }
  }, [reload, interval]);
  return { data, error, reload };
}
