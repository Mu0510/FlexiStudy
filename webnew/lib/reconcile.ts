export function shallowEqual(a: any, b: any) {
  if (a === b) return true
  if (!a || !b) return false
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

export function reconcileArrayById<T extends Record<string, any>>(prevArr: T[] = [], nextArr: T[] = [], idKey: keyof T = 'id' as any): T[] {
  const prevMap = new Map<any, T>()
  for (const it of prevArr) prevMap.set(it[idKey], it)
  const result: T[] = []
  for (const next of nextArr) {
    const prev = prevMap.get(next[idKey])
    if (prev && shallowEqual(prev, next)) result.push(prev)
    else result.push({ ...(prev || {}), ...next })
  }
  return result
}

export function reconcileDashboard(prev: any, next: any) {
  if (!prev) return next
  const merged: any = { ...prev }
  // studyStats 全体
  merged.studyStats = shallowEqual(prev.studyStats, next.studyStats) ? prev.studyStats : next.studyStats
  // todayGoals は差分マージ（id）
  merged.todayGoals = reconcileArrayById(prev.todayGoals, next.todayGoals, 'id')
  // recentSessions は単純更新（件数少）
  merged.recentSessions = next.recentSessions
  return merged
}

export function reconcileLogData(prev: any, next: any) {
  if (!prev) return next
  const merged: any = { ...prev }
  merged.daily_summary = shallowEqual(prev.daily_summary, next.daily_summary) ? prev.daily_summary : next.daily_summary
  const prevSessions = prev.sessions || []
  const nextSessions = next.sessions || []
  const prevMap = new Map<number, any>()
  for (const s of prevSessions) prevMap.set(Number(s.session_id), s)
  const outSessions: any[] = []
  for (const ns of nextSessions) {
    const ps = prevMap.get(Number(ns.session_id))
    if (!ps) { outSessions.push(ns); continue }
    const mergedSession: any = { ...ps }
    mergedSession.start_time = ns.start_time
    mergedSession.end_time = ns.end_time
    mergedSession.total_duration = ns.total_duration
    // logs 差分
    const psLogs = ps.logs || []
    const nsLogs = ns.logs || []
    mergedSession.logs = reconcileArrayById(psLogs, nsLogs, 'id')
    // 変化がなければ既存参照を使う
    if (
      ps.start_time === ns.start_time &&
      ps.end_time === ns.end_time &&
      ps.total_duration === ns.total_duration &&
      psLogs.length === mergedSession.logs.length && psLogs.every((l: any, i: number) => l === mergedSession.logs[i])
    ) {
      outSessions.push(ps)
    } else {
      outSessions.push(mergedSession)
    }
  }
  merged.sessions = outSessions
  return merged
}

