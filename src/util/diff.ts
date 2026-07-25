/**
 * Minimal, dependency-free line diff.
 *
 * Computes a longest-common-subsequence over lines and emits a flat list of
 * add / del / context rows — enough to render a Claude-Code-style green/red view.
 * Kept intentionally small: inputs here are edit *snippets* (the found text and
 * its replacement), not whole files.
 */

export type DiffRowType = "add" | "del" | "ctx";

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

export function lineDiff(before: string, after: string): DiffRow[] {
  // An empty string is zero lines, not one blank line — otherwise a pure
  // deletion (content: "") renders a spurious "+" empty-line addition.
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Backtrack into an ordered row list.
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: "del", text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: a[i++] });
  while (j < m) rows.push({ type: "add", text: b[j++] });

  return rows;
}
