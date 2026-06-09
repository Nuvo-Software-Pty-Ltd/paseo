// Pure conversion between the `expiresAt` wire value (an ISO-8601 string, empty
// when unset) and the value an <input type="datetime-local"> uses
// ("YYYY-MM-DDTHH:mm", timezone-less). We treat the picker value as UTC
// wall-clock so the round-trip is deterministic and independent of the device's
// local timezone — the field previously held a UTC ISO string verbatim, so this
// keeps the same meaning. RN-free so it can be unit-tested in the node project.

const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

// ISO-8601 -> datetime-local value (minute precision). Empty / unparseable -> "".
export function isoToDateTimeLocal(iso: string): string {
  const trimmed = iso.trim();
  if (!trimmed) {
    return "";
  }
  const match = ISO_PREFIX_RE.exec(trimmed);
  if (!match) {
    return "";
  }
  return `${match[1]}T${match[2]}`;
}

// datetime-local value -> ISO-8601 (UTC). Empty / unparseable -> "".
export function dateTimeLocalToIso(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const match = DATE_TIME_LOCAL_RE.exec(trimmed);
  if (!match) {
    return "";
  }
  const [, year, month, day, hours, minutes, seconds] = match;
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds ?? "00"}.000Z`;
}
