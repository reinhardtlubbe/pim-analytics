const integerFormatter = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatZar(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `R ${decimalFormatter.format(value)}`;
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return integerFormatter.format(Math.round(value));
}

export function formatDecimal(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return new Intl.NumberFormat('en-ZA', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${formatDecimal(value, digits)}%`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1048576) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function nextMonth(): string {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const month = date.getMonth() + 1;
  return `${date.getFullYear()}-${month < 10 ? `0${month}` : month}`;
}
