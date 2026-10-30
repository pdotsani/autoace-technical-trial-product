/** RFC 4180 CSV with CRLF line endings; a field is quoted only when it needs to be (like csv-stringify). */
export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(field).join(",") + "\r\n").join("");
}

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
