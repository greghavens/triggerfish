/**
 * Sheets tool executor.
 *
 * Handles dispatch for sheets_read and sheets_write.
 *
 * @module
 */

import type { SheetsService } from "../types.ts";

/** Validate that a value is a non-empty string. */
function requireNonEmptyString(
  value: unknown,
  field: string,
  tool: string,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `Error: ${tool} requires a non-empty '${field}' argument.`;
  }
  return null;
}

/** Parse a JSON string into a 2D string array. Returns an error string on failure. */
function parseValuesArray(valuesStr: string): string[][] | string {
  try {
    const parsed = JSON.parse(valuesStr);
    if (!Array.isArray(parsed)) {
      return 'Error: \'values\' must be a valid JSON 2D array (e.g. [["a","b"],["c","d"]])';
    }
    return parsed as string[][];
  } catch {
    return 'Error: \'values\' must be a valid JSON 2D array (e.g. [["a","b"],["c","d"]])';
  }
}

/** Execute sheets_read tool. */
export async function readGoogleSheet(
  sheets: SheetsService,
  input: Record<string, unknown>,
): Promise<string> {
  const idErr = requireNonEmptyString(
    input.spreadsheet_id,
    "spreadsheet_id",
    "sheets_read",
  );
  if (idErr) return idErr;
  const rangeErr = requireNonEmptyString(input.range, "range", "sheets_read");
  if (rangeErr) return rangeErr;

  const result = await sheets.read(
    input.spreadsheet_id as string,
    input.range as string,
  );
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({
    range: result.value.range,
    values: result.value.values,
  });
}

/** @deprecated Use readGoogleSheet instead */
export const executeSheetsRead = readGoogleSheet;

/** Execute sheets_write tool. */
export async function writeGoogleSheet(
  sheets: SheetsService,
  input: Record<string, unknown>,
): Promise<string> {
  const idErr = requireNonEmptyString(
    input.spreadsheet_id,
    "spreadsheet_id",
    "sheets_write",
  );
  if (idErr) return idErr;
  const rangeErr = requireNonEmptyString(input.range, "range", "sheets_write");
  if (rangeErr) return rangeErr;
  const valErr = requireNonEmptyString(input.values, "values", "sheets_write");
  if (valErr) {
    return "Error: sheets_write requires a 'values' argument (JSON 2D array).";
  }

  const values = parseValuesArray(input.values as string);
  if (typeof values === "string") return values;

  const result = await sheets.write({
    spreadsheetId: input.spreadsheet_id as string,
    range: input.range as string,
    values,
  });
  if (!result.ok) return `Error: ${result.error.message}`;

  return JSON.stringify({
    written: true,
    range: result.value.range,
  });
}

/** @deprecated Use writeGoogleSheet instead */
export const executeSheetsWrite = writeGoogleSheet;
