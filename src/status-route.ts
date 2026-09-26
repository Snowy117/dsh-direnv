/**
 * Serves the sidebar's read-only view of the evaluator.
 *
 * DSH's own `/plugins/*` carrier is unfenced — it answers without a cookie and
 * without a Host/Origin check — so a route that reports workspace paths and
 * variable values must admit through the connection service itself.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'

import type { Gate } from './gate.ts'
import type { Evaluator, LogFn, PluginContext, Settings, StatusRecord } from './types.ts'
import type { StatusEnvelope, WireConfig } from './wire.ts'

const ROUTE_PATH = '/plugins/dsh-direnv/status.json'

export interface StatusRouteDeps {
  evaluator: Evaluator
  gate: Gate
  config: Settings
  log: LogFn
  sessionDirs: Map<string, string>
  plugin: { name: string; version: string }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Values leave the host only when the operator asked for them: the record is the
 * same object otherwise, and the default answer is the record minus `env`.
 */
function project(status: StatusRecord, includeValues: boolean): StatusRecord {
  if (includeValues) return status
  const { env, ...rest } = status
  return { ...rest, env: null }
}

export function registerStatusRoute(ctx: PluginContext, deps: StatusRouteDeps): unknown {
  const { evaluator, gate, config, log, sessionDirs, plugin } = deps

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const connection = ctx.get('connection')
      if (connection === undefined) {
        sendJson(res, 503, { ok: false, error: 'connection service unavailable' })
        return
      }
      const admission = connection.admit(req)
      if (admission.rejection !== undefined) {
        res.writeHead(admission.rejection)
        res.end()
        return
      }
      if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const requested = url.searchParams.get('dir')
      const dir =
        requested !== null && isAbsolute(requested)
          ? requested
          : sessionId === undefined
            ? undefined
            : sessionDirs.get(sessionId)

      if (dir === undefined) {
        const empty: StatusEnvelope = {
          ok: true,
          plugin,
          sessionId: sessionId ?? null,
          dir: null,
          status: null,
          gate: null,
        }
        sendJson(res, 200, empty)
        return
      }
      if (url.searchParams.get('force') === '1') void evaluator.prewarm(dir, { force: true })

      const sidecar: WireConfig = {
        disabledDirs: config.disabledDirs ?? [],
        loadTimeoutMs: config.loadTimeoutMs,
        evaluateTimeoutMs: config.evaluateTimeoutMs,
      }
      const envelope: StatusEnvelope = {
        ok: true,
        plugin,
        sessionId: sessionId ?? null,
        dir,
        status: project(evaluator.status(dir), url.searchParams.get('values') === '1'),
        gate: sessionId === undefined ? null : gate.describe(sessionId),
        config: sidecar,
      }
      sendJson(res, 200, envelope)
    } catch (error) {
      log('warn', 'status route failed', { error })
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
    }
  }

  return ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    'dsh-direnv status route',
  )
}
