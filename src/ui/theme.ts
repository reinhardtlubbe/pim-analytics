import { Platform } from 'react-native';

export const colors = {
  backgroundTop: '#0b0f19',
  backgroundBottom: '#111827',
  glass: 'rgba(30, 41, 59, 0.7)',
  glassStrong: 'rgba(30, 41, 59, 0.92)',
  glassBorder: 'rgba(255, 255, 255, 0.1)',
  glassHighlight: 'rgba(255, 255, 255, 0.04)',
  primary: '#3b82f6',
  primaryPressed: '#2563eb',
  primarySoft: 'rgba(59, 130, 246, 0.16)',
  success: '#10b981',
  successSoft: 'rgba(16, 185, 129, 0.15)',
  warning: '#f59e0b',
  warningSoft: 'rgba(245, 158, 11, 0.15)',
  danger: '#ef4444',
  dangerSoft: 'rgba(239, 68, 68, 0.15)',
  muted: '#64748b',
  mutedSoft: 'rgba(100, 116, 139, 0.18)',
  textPrimary: '#f8fafc',
  textSecondary: '#cbd5e1',
  textMuted: '#94a3b8',
  inputBackground: 'rgba(15, 23, 42, 0.75)',
  overlay: 'rgba(2, 6, 23, 0.72)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  pill: 999,
};

const tabularFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: undefined });

export const typography = {
  title: { fontSize: 26, fontWeight: '800' as const, color: colors.textPrimary, letterSpacing: -0.4 },
  heading: { fontSize: 18, fontWeight: '700' as const, color: colors.textPrimary },
  subheading: { fontSize: 15, fontWeight: '600' as const, color: colors.textPrimary },
  body: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  caption: { fontSize: 12, color: colors.textMuted },
  label: { fontSize: 12, fontWeight: '700' as const, color: colors.textMuted, letterSpacing: 0.6, textTransform: 'uppercase' as const },
  tabular: { fontSize: 13, color: colors.textPrimary, fontVariant: ['tabular-nums' as const], fontFamily: tabularFamily },
};

export const uiTheme = { colors, spacing, radius, typography };
export const _uiTheme = uiTheme;

if (typeof globalThis !== 'undefined') {
  (globalThis as any)._uiTheme = _uiTheme;
}
if (typeof global !== 'undefined') {
  (global as any)._uiTheme = _uiTheme;
}
