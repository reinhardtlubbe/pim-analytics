import { BadgeTone, StatusBadge } from './ui';

const RUN_TONES: Record<string, { tone: BadgeTone; label: string }> = {
  running: { tone: 'info', label: 'Running' },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'danger', label: 'Failed' },
  superseded: { tone: 'muted', label: 'Superseded' },
  registered: { tone: 'info', label: 'Registered' },
  mapped: { tone: 'warning', label: 'Mapped' },
  processing: { tone: 'info', label: 'Processing' },
  processed: { tone: 'success', label: 'Processed' },
};

export function RunStatusBadge({ status }: { status: string | null }) {
  const entry = RUN_TONES[status ?? ''] ?? { tone: 'muted' as BadgeTone, label: status ?? 'Unknown' };
  return <StatusBadge label={entry.label} tone={entry.tone} />;
}
