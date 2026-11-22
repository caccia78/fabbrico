/** Run a (possibly async) action and show its error, if any. */
export function runAction(fn: () => unknown) {
  const fail = (e: unknown) => alert((e as Error).message);
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(fail);
  } catch (e) {
    fail(e);
  }
}
