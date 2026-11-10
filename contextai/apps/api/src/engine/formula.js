// Tiny arithmetic evaluator for developer-defined metrics such as "(price - cost) * quantity".
// Only field names, numbers, + - * / and parentheses are accepted; nothing is ever eval'd.

export function parseFormula(source) {
  const tokens = String(source).match(/\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[-+*/()])\s*/g)?.map((t) => t.trim());
  if (!tokens || tokens.join('') !== String(source).replace(/\s+/g, '')) throw new Error(`Invalid formula: ${source}`);
  let pos = 0;
  const fields = new Set();
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function primary() {
    const t = next();
    if (t === '(') { const e = expr(); if (next() !== ')') throw new Error('Missing )'); return e; }
    if (t === '-') { const e = primary(); return (row) => { const v = e(row); return v == null ? null : -v; }; }
    if (/^\d/.test(t)) { const n = Number(t); return () => n; }
    if (/^[A-Za-z_]/.test(t)) { fields.add(t); return (row) => (typeof row[t] === 'number' ? row[t] : null); }
    throw new Error(`Unexpected token in formula: ${t}`);
  }
  function binary(sub, ops) {
    return () => {
      let left = sub();
      while (ops.includes(peek())) {
        const op = next();
        const right = sub();
        const l = left;
        left = (row) => {
          const a = l(row); const b = right(row);
          if (a == null || b == null) return null;
          if (op === '/') return b === 0 ? null : a / b;
          return op === '+' ? a + b : op === '-' ? a - b : a * b;
        };
      }
      return left;
    };
  }
  const term = binary(primary, ['*', '/']);
  const expr = binary(term, ['+', '-']);
  const evaluate = expr();
  if (pos !== tokens.length) throw new Error(`Unexpected token in formula: ${peek()}`);
  return { evaluate, fields: [...fields] };
}
