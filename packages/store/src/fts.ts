/**
 * Building FTS5 `MATCH` expressions from user input.
 *
 * This exists because of a specific hazard: gjsify's `node:sqlite` is a libgda wrapper whose
 * `all()`/`get()` SWALLOW exceptions and return `[]`. A malformed MATCH expression therefore
 * does not raise — it silently returns NO RESULTS, which is indistinguishable from "nothing
 * matched". Raw user input must never reach MATCH; it is rebuilt here from sanitized tokens.
 *
 * FTS5 treats `"` `*` `:` `^` `(` `)` `-` and the bare words AND/OR/NOT/NEAR as syntax, so a
 * query as ordinary as `re: Angebot (2025)` is a syntax error, and `energie-berater` silently
 * means "energie NOT berater".
 */

/** One token of a parsed query: a bare word or an explicitly quoted phrase. */
interface Token {
  text: string;
  phrase: boolean;
}

/**
 * Split input into words and quoted phrases, ignoring everything else.
 *
 * Deliberately permissive about what a "word" is: anything that is not whitespace or a quote.
 * Narrowing it to letters and digits would drop the parts of a query that identify a thing —
 * `rechnung-2025`, `k.mueller@example.com`, `AZ 4711/25`.
 */
function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === '"') {
      const end = query.indexOf('"', i + 1);
      // An unterminated quote takes the rest of the input as one phrase, which is what someone
      // typing it meant, rather than an error.
      const text = end < 0 ? query.slice(i + 1) : query.slice(i + 1, end);
      if (text.trim()) tokens.push({ text: text.trim(), phrase: true });
      i = end < 0 ? query.length : end + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    let end = i;
    while (end < query.length && !/[\s"]/.test(query[end])) end++;
    const text = query.slice(i, end);
    if (text) tokens.push({ text, phrase: false });
    i = end;
  }
  return tokens;
}

/**
 * Quote a token as an FTS5 string, which is the ONLY form that cannot be mistaken for syntax.
 *
 * Inside a quoted FTS5 string the sole escape is a doubled `"`; everything else — hyphens,
 * colons, parentheses, even the word AND — is literal. So quoting is both the sanitizer and the
 * way to make `energie-berater` mean what the user typed.
 */
function quote(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Build a MATCH expression that ANDs every token.
 *
 * Returns null when nothing usable remains, which callers must treat as "no full-text filter"
 * rather than "matches nothing" — passing an empty string to MATCH is a syntax error, and
 * therefore (see above) an empty result set.
 */
export function toFts5Match(query: string | undefined | null): string | null {
  const tokens = tokenize(query ?? '');
  if (tokens.length === 0) return null;
  return tokens.map((t) => quote(t.text)).join(' AND ');
}

/**
 * Build a MATCH expression restricted to one FTS column, e.g. `subject`.
 *
 * The column name is NOT user input — callers pass a literal — but it is validated anyway, so a
 * future caller that forwards a parameter cannot turn it into an injection point.
 */
export function toFts5ColumnMatch(column: string, query: string | undefined | null): string | null {
  if (!/^[a-z_]+$/.test(column)) throw new Error(`invalid FTS column: ${column}`);
  const tokens = tokenize(query ?? '');
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${column} : ${quote(t.text)}`).join(' AND ');
}
