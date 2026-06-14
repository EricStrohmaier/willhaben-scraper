export function withAbort<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return fn();
  if (signal.aborted) return Promise.reject(new Error("Aborted"));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    fn().then(
      (v) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        }
      },
      (e) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(e);
        }
      }
    );
  });
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
