import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

let restartInFlight: Promise<void> | null = null;
let lastScheduledAt: number | null = null;

type RestartFn = (reason?: string) => Promise<unknown> | unknown;

function resolveNotifyFn(mod: any): ((reason?: string) => unknown) | null {
  if (typeof mod?.notifyClientsOfReload === 'function') return mod.notifyClientsOfReload;
  if (typeof mod?.default?.notifyClientsOfReload === 'function') return mod.default.notifyClientsOfReload;
  return null;
}

function resolveRestartFn(mod: any): RestartFn | null {
  if (!mod) return null;

  const direct = typeof mod.requestServerRestart === 'function'
    ? mod.requestServerRestart
    : typeof mod.default?.requestServerRestart === 'function'
      ? mod.default.requestServerRestart
      : null;
  if (typeof direct === 'function') {
    return direct;
  }

  const fallback = typeof mod.restartServer === 'function'
    ? mod.restartServer
    : typeof mod.default?.restartServer === 'function'
      ? mod.default.restartServer
      : null;

  if (typeof fallback === 'function') {
    const notify = resolveNotifyFn(mod);
    return (reason?: string) => {
      if (notify) {
        const notifyReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'api-fallback';
        try { notify(notifyReason); } catch {}
      }
      return fallback();
    };
  }

  return null;
}

async function getRestartFunction(): Promise<RestartFn> {
  const globalControl: any = (globalThis as any).__flexiServerControl;
  const fromGlobal = resolveRestartFn(globalControl);
  if (fromGlobal) return fromGlobal;

  try {
    const mod: any = await import('../../../../server');
    const resolved = resolveRestartFn(mod);
    if (resolved) return resolved;
  } catch (error) {
    console.error('[api/server/restart] Failed to load server control module:', error);
  }

  throw new Error('requestServerRestart is not available');
}

export async function POST(request: Request) {
  try {
    const restartFn = await getRestartFunction();

    if (restartInFlight) {
      return NextResponse.json(
        { ok: true, status: 'in-progress', scheduledAt: lastScheduledAt },
        { status: 202 },
      );
    }

    let reason = 'api-request';
    if (request) {
      try {
        const body = await request.json();
        if (body && typeof body.reason === 'string' && body.reason.trim()) {
          reason = body.reason.trim();
        }
      } catch {}
    }

    lastScheduledAt = Date.now();
    const scheduled = Promise.resolve(restartFn(reason))
      .catch((err) => {
        console.error('[api/server/restart] Restart failed:', err);
      })
      .finally(() => {
        restartInFlight = null;
      });
    restartInFlight = scheduled.then(() => undefined);

    return NextResponse.json(
      { ok: true, status: 'scheduled', scheduledAt: lastScheduledAt },
      { status: 202 },
    );
  } catch (error: any) {
    console.error('[api/server/restart] Failed to schedule restart:', error);
    return NextResponse.json(
      { ok: false, error: error?.message || 'failed to schedule restart' },
      { status: 500 },
    );
  }
}
