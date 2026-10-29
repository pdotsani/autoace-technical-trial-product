import { parse } from "csv-parse/sync";

export interface CsvRow {
  row: number; // spreadsheet row number: the header is row 1, so data starts at row 2
  name: string; // exactly as written in the CSV
  resultJson: string; // "" when the column is absent or the cell is empty
}

export type ParsedCsv =
  | { ok: true; rows: CsvRow[]; hasResultColumn: boolean }
  | { ok: false; error: string };

/** Parse the manifest CSV: a required "name" column and an optional "result_json" column. */
export function parseManifestCsv(text: string): ParsedCsv {
  let records: string[][];
  try {
    records = parse(text, { bom: true, skip_empty_lines: true });
  } catch (err) {
    return { ok: false, error: `CSV could not be parsed: ${(err as Error).message}` };
  }
  const [header, ...body] = records;
  if (!header) return { ok: false, error: "CSV is empty" };

  const columns = header.map((c) => c.trim().toLowerCase());
  const nameCol = columns.indexOf("name");
  const resultCol = columns.indexOf("result_json");
  if (nameCol < 0) return { ok: false, error: 'CSV has no "name" column' };

  const rows = body.map((record, i) => ({
    row: i + 2,
    name: record[nameCol] ?? "",
    resultJson: resultCol >= 0 ? (record[resultCol] ?? "").trim() : "",
  }));
  return { ok: true, rows, hasResultColumn: resultCol >= 0 };
}
