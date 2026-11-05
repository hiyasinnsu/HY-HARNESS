// CP-39/C5: a tiny metrics snapshot for observability.
//
// The process-wide facts a local operator needs: uptime, open sessions and
// resident memory. No external agent or exporter is involved; the values are
// also reported by `hy doctor` when it can reach the web server.

export interface MetricsSnapshot {
  uptimeSeconds: number
  sessions: number
  rssBytes: number
}

export function metricsSnapshot(input: { uptimeSeconds: number; sessions: number; rssBytes: number }): MetricsSnapshot {
  const round = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)
  return {
    uptimeSeconds: round(input.uptimeSeconds),
    sessions: round(input.sessions),
    rssBytes: round(input.rssBytes),
  }
}