// Concurrency helpers for the staging-verify runner (VTID-05672).
// Plain Node, no CI-provider calls, so GitLab runners can reuse the same script.

// Bounded parallelism: at most `limit` tasks run at once; the rest wait in FIFO order.
export function createLimiter(limit) {
  const max = Math.max(1, Number.parseInt(String(limit), 10) || 1);
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// Exclusive lock per key: tasks with the same key never overlap; a failing task
// does not block the next one. Keys are independent of each other.
export function createLocks() {
  const tails = new Map();
  return (key, fn) => {
    const prev = tails.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  };
}
