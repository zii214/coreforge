// Boot and shutdown for the forge process.
//
// The trial harness owns this process's lifetime, and the deal is simple:
//
//   - The harness tells us where it lives through MAKEFUN_ENV_URL. With no
//     such variable there is nobody to serve for, so we exit at once.
//   - We open the HTTP app on a port the kernel chooses (listen(0)). Port
//     8080 belongs to the harness and is never ours to take.
//   - We introduce ourselves with POST /register and the port we landed on.
//     The harness notes the address the request arrived from and reaches
//     the app through it from then on. Registration is first-come: a 409
//     only means another process got there first, which is not a failure
//     of this one, so we carry on either way.
//   - We then ask GET /done every so often. The harness answers right away
//     (false while its suite is running, true once it is finished), so
//     polling is the whole protocol. We leave only when it says true:
//     close the app, exit 0, and let the harness collect its export.
//
// Transient trouble — the harness still starting, a dropped request, a
// slow answer — is retried with a growing pause. Only a refusal that
// says the registration itself breaks the contract (400 / 405) ends the
// process early, as does a failure to bind a port at all.

import { createApp } from './app.ts';

/** A refusal that retrying cannot fix: the harness rejected the contract itself. */
class FatalEnvError extends Error {}

/** Pause that doubles after every use, from a quarter second up to a two-second ceiling. */
class Backoff {
  #current = 250;

  async wait(): Promise<void> {
    const ms = this.#current;
    this.#current = Math.min(2_000, this.#current * 2);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

/** Where the harness lives, normalized so paths can be appended directly. Missing means exit 1. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const origin = raw.replace(/\/+$/, '');
  if (origin === '') {
    process.stderr.write('forge: MAKEFUN_ENV_URL is not set, so there is no harness to register with\n');
    process.exit(1);
  }
  return origin;
}

/** One call to the harness, abandoned after thirty seconds so a hung request cannot hang us. */
function envFetch(origin: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
}

/**
 * Tell the harness which port the app bound. Accepted (200) and beaten-to-it
 * (409) both end the introduction; 400 and 405 mean the registration itself
 * is malformed, which no retry will change; anything else is worth another
 * try after a pause, because the harness may simply not be up yet.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    let settled = false;
    try {
      const res = await envFetch(origin, '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) {
        settled = true;
      } else if (res.status === 400 || res.status === 405) {
        throw new FatalEnvError(`registration refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof FatalEnvError) throw err;
      // A network error or a timeout: the harness is not ready. Fall through and retry.
    }
    if (settled) return;
    await backoff.wait();
  }
}

/** Ask the harness whether the trial is over, and keep asking until it says so. */
async function untilEnvSaysDone(origin: string): Promise<void> {
  const backoff = new Backoff();
  for (;;) {
    try {
      const res = await envFetch(origin, '/done');
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Unreachable or unparseable is just another spelling of "not done yet".
    }
    await backoff.wait();
  }
}

/** Start the app on a kernel-chosen port and report which one it picked. */
async function bindEphemeral(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the app did not bind an ephemeral TCP port');
  }
  return { server, port: address.port };
}

/** The whole run: bind, introduce, wait to be dismissed, close. */
async function run(): Promise<void> {
  const origin = envOrigin();
  const { server, port } = await bindEphemeral();
  process.stdout.write(`forge: listening on port ${port}\n`);

  await announcePort(origin, port);
  process.stdout.write('forge: registered; serving until the harness says done\n');

  await untilEnvSaysDone(origin);
  server.close();
  process.stdout.write('forge: done\n');
}

(async () => {
  try {
    await run();
    process.exit(0);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`forge: ${detail}\n`);
    process.exit(1);
  }
})();
