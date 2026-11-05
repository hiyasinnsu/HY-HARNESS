function parseField(text, min, max) {
    const values = new Set();
    let wildcard = false;
    for (const part of text.split(',')) {
        const trimmed = part.trim();
        if (!trimmed)
            return undefined;
        const stepMatch = /^(.+)\/(\d+)$/.exec(trimmed);
        const rangeText = stepMatch?.[1] ?? trimmed;
        const step = stepMatch ? Number(stepMatch[2]) : 1;
        if (!Number.isInteger(step) || step <= 0)
            return undefined;
        let start;
        let end;
        if (rangeText === '*') {
            start = min;
            end = max;
            wildcard = true;
        }
        else {
            const range = /^(\d+)-(\d+)$/.exec(rangeText);
            if (range) {
                start = Number(range[1]);
                end = Number(range[2]);
            }
            else if (/^\d+$/.test(rangeText)) {
                start = Number(rangeText);
                end = stepMatch ? max : start;
            }
            else
                return undefined;
        }
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end)
            return undefined;
        for (let value = start; value <= end; value += step)
            values.add(value);
    }
    return values.size > 0 ? { values, wildcard } : undefined;
}
export function parseCron(expression) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5)
        return undefined;
    const minute = parseField(fields[0], 0, 59);
    const hour = parseField(fields[1], 0, 23);
    const day = parseField(fields[2], 1, 31);
    const month = parseField(fields[3], 1, 12);
    const weekday = parseField(fields[4], 0, 7);
    if (!minute || !hour || !day || !month || !weekday)
        return undefined;
    // 7 is Sunday in some cron dialects; normalize it to 0.
    if (weekday.values.has(7)) {
        weekday.values.delete(7);
        weekday.values.add(0);
    }
    return { minute, hour, day, month, weekday };
}
export function cronMatches(expression, date) {
    const spec = parseCron(expression);
    return spec ? matches(spec, date) : false;
}
function matches(spec, date) {
    if (!spec.minute.values.has(date.getMinutes()))
        return false;
    if (!spec.hour.values.has(date.getHours()))
        return false;
    if (!spec.month.values.has(date.getMonth() + 1))
        return false;
    const dayOk = spec.day.values.has(date.getDate());
    const weekdayOk = spec.weekday.values.has(date.getDay());
    return spec.day.wildcard && spec.weekday.wildcard
        ? true
        : spec.day.wildcard
            ? weekdayOk
            : spec.weekday.wildcard
                ? dayOk
                : dayOk || weekdayOk;
}
/** The next matching minute strictly after `from`, or undefined within a year. */
export function nextCronTime(expression, from = new Date()) {
    const spec = parseCron(expression);
    if (!spec)
        return undefined;
    const cursor = new Date(from.getTime());
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) {
        if (matches(spec, cursor))
            return new Date(cursor.getTime());
        cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return undefined;
}
