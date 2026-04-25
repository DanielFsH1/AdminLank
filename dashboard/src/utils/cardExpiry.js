function clampMonth(rawMonth) {
  const numericMonth = Number.parseInt(rawMonth || '0', 10);

  if (Number.isNaN(numericMonth) || numericMonth <= 0) return '01';
  if (numericMonth >= 12) return '12';

  return String(numericMonth).padStart(2, '0');
}

function normalizeYear(rawYear) {
  if (!rawYear) return '';
  if (rawYear.length === 2) return `20${rawYear}`;
  return rawYear.slice(0, 4);
}

export function normalizeCardExpiryInput(rawValue) {
  const digits = String(rawValue || '').replace(/\D/g, '').slice(0, 6);

  if (digits.length <= 2) {
    return digits;
  }

  const month = clampMonth(digits.slice(0, 2));
  const year = normalizeYear(digits.slice(2));

  return year ? `${month}/${year}` : month;
}
