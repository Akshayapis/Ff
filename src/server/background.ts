/** Background jobs: poll pending deposits (safety net next to the webhook) and auto-start matches. */
import { init, autoProgress } from "./core";
import { pollPendingDeposits } from "./payment";

const g = globalThis as typeof globalThis & { __hzBg?: boolean };

export function startBackground() {
  if (g.__hzBg) return;
  g.__hzBg = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await init();
      await autoProgress();
      await pollPendingDeposits();
    } catch (e) {
      console.error("background job error:", (e as Error).message);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, 30_000);
  t.unref?.();
  setTimeout(tick, 5_000).unref?.();
}
