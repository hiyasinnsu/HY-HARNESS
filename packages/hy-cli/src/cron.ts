// Small 5-field cron parser for the Automation panel. Fields:
// minute hour day-of-month month day-of-week. Supports *, */n, lists, ranges
// and range steps. Day-of-month and day-of-week use the usual OR rule when
// both are restricted.
interface Field {
  values: Set<number>
  wildcard: boolean
}

export interface CronSpec {
  minute: Field
  hour: Field
  day: Field
  month: Field
  weekday: Field
}

function parseField(text: string, min: number, max: number): Field | undefined {
  const values = new Set<number>()
  let wildcard = false
  for (const part of text.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) return undefined
    const stepMatch = /^(.+)\/(\d+)$/.exec(trimmed)
    const rangeText = stepMatch?.[1] ?? trimmed
    const step = stepMatch ? Number(stepMatch[2]) : 1
    if (!Number.isInteger(step) || step <= 0) return undefined
    let start: number
    let end: number
    if (rangeText === '*') {
      start = min
      end = max
      wildcard = true
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangeText)
      if (range) {
        start = Number(range[1])
        end = Number(range[2])
      } else if (/^\d+$/.test(rangeText)) {
        start = Number(rangeText)
        end = stepMatch ? max : start
      } else return undefined
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return undefined
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values.size > 0 ? { values, wildcard } : undefined
}

export function parseCron(expression: string): CronSpec | undefined {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const minute = parseField(fields[0]!, 0, 59)
  const hour = parseField(fields[1]!, 0, 23)
  const day = parseField(fields[2]!, 1, 31)
  const month = parseField(fields[3]!, 1, 12)
  const weekday = parseField(fields[4]!, 0, 7)
  if (!minute || !hour || !day || !month || !weekday) return undefined
  // 7 is Sunday in some cron dialects; normalize it to 0.
  if (weekday.values.has(7)) {
    weekday.values.delete(7)
    weekday.values.add(0)
  }
  return { minute, hour, day, month, weekday }
}

export function cronMatches(expression: string, date: Date): boolean {
  const spec = parseCron(expression)
  return spec ? matches(spec, date) : false
}

function matches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.values.has(date.getMinutes())) return false
  if (!spec.hour.values.has(date.getHours())) return false
  if (!spec.month.values.has(date.getMonth() + 1)) return false
  const dayOk = spec.day.values.has(date.getDate())
  const weekdayOk = spec.weekday.values.has(date.getDay())
  return spec.day.wildcard && spec.weekday.wildcard
    ? true
    : spec.day.wildcard
      ? weekdayOk
      : spec.weekday.wildcard
        ? dayOk
        : dayOk || weekdayOk
}

/** The next matching minute strictly after `from`, or undefined within a year. */
export function nextCronTime(expression: string, from = new Date()): Date | undefined {
  const spec = parseCron(expression)
  if (!spec) return undefined
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(spec, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return undefined
}
