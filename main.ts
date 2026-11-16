/**
 * ghforge — a standalone GitHub-compatible git forge in one Node 22 process.
 *
 * Lifecycle (the suite's contract): bind an ephemeral port, POST it to
 * $MAKEFUN_ENV_URL/register, serve until the suite answers
 * {"done": true} on $MAKEFUN_ENV_URL/done, then exit 0. Port 8080 belongs to
 * the suite and is never bound. Run standalone (no MAKEFUN_ENV_URL), the
 * forge simply serves until it is stopped — the mode the local runner uses.
 */

import { createApp } from './src/app.ts';
import { Forge } from './src/store.ts';

const forge = new Forge();
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const server = createApp(forge, token);

await new Promise<void>((resolve) => {
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  throw new Error('the forge could not bind an ephemeral port');
}
const port = address.port;

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.log(`ghforge listening on port ${port}`);
} else {
  const base = envUrl.replace(/\/+$/, '');
  // Register the port the suite should dial. The first registration wins, so
  // a transient failure is worth retrying until the boot budget runs out.
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) break;
    } catch {
      // the suite may still be coming up; retry below
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // Long-poll /done until the suite has finished and written its export.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const response = await fetch(`${base}/done`);
      if (!response.ok) continue;
      const body = (await response.json()) as { done?: unknown };
      if (body.done === true) break;
    } catch {
      // a poll that fails is retried; the suite decides when we are done
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
