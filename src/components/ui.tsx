import { Ionicons } from '@expo/vector-icons';
import React, { ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { colors, radius, spacing, typography } from '../ui/theme';

type IconName = keyof typeof Ionicons.glyphMap;

export function GlassCard({ children, style, padded = true }: { children: ReactNode; style?: ViewStyle | ViewStyle[]; padded?: boolean }) {
  return <View style={[styles.card, padded && styles.cardPadding, style]}>{children}</View>;
}

export function SectionTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <View style={styles.flex}>
        <Text style={typography.heading}>{title}</Text>
        {subtitle ? <Text style={[typography.caption, styles.subtitle]}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  compact,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  compact?: boolean;
  style?: ViewStyle;
  accessibilityHint?: string;
}) {
  const palette = {
    primary: { background: colors.primary, border: colors.primary, text: '#ffffff' },
    success: { background: colors.success, border: colors.success, text: '#022c22' },
    secondary: { background: colors.glassHighlight, border: colors.glassBorder, text: colors.textPrimary },
    danger: { background: colors.dangerSoft, border: 'rgba(239, 68, 68, 0.45)', text: '#fecaca' },
    ghost: { background: 'transparent', border: 'transparent', text: colors.primary },
  }[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(loading) }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: palette.background, borderColor: palette.border, opacity: inactive ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={palette.text} /> : icon ? <Ionicons name={icon} size={compact ? 16 : 18} color={palette.text} /> : null}
      <Text style={[styles.buttonLabel, compact && styles.buttonLabelCompact, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

const BADGE_TONES: Record<BadgeTone, { background: string; color: string; icon: IconName }> = {
  success: { background: colors.successSoft, color: colors.success, icon: 'checkmark-circle' },
  warning: { background: colors.warningSoft, color: colors.warning, icon: 'alert-circle' },
  danger: { background: colors.dangerSoft, color: colors.danger, icon: 'close-circle' },
  info: { background: colors.primarySoft, color: colors.primary, icon: 'information-circle' },
  muted: { background: colors.mutedSoft, color: colors.textMuted, icon: 'remove-circle' },
};

export function StatusBadge({ label, tone, icon }: { label: string; tone: BadgeTone; icon?: IconName }) {
  const style = BADGE_TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: style.background }]} accessibilityLabel={label}>
      <Ionicons name={icon ?? style.icon} size={13} color={style.color} />
      <Text style={[styles.badgeLabel, { color: style.color }]}>{label}</Text>
    </View>
  );
}

export function TextField({ label, error, hint, ...props }: TextInputProps & { label: string; error?: string | null; hint?: string }) {
  return (
    <View style={styles.field}>
      <Text style={typography.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        style={[styles.input, error ? styles.inputError : null, props.multiline ? styles.inputMultiline : null]}
        accessibilityLabel={label}
        {...props}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : hint ? <Text style={typography.caption}>{hint}</Text> : null}
    </View>
  );
}

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  description?: string;
  tone?: BadgeTone;
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled,
  compact,
  status,
}: {
  label?: string;
  value: T | null | undefined;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  status?: BadgeTone;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.value === value);
  const borderColor = status === 'warning' ? colors.warning : status === 'danger' ? colors.danger : status === 'success' ? 'rgba(16, 185, 129, 0.45)' : colors.glassBorder;
  return (
    <View style={styles.field}>
      {label ? <Text style={typography.label}>{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label ?? 'Selection'}: ${selected?.label ?? placeholder}`}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[styles.select, compact && styles.selectCompact, { borderColor, opacity: disabled ? 0.5 : 1 }]}
      >
        <Text style={[styles.selectText, !selected && { color: colors.textMuted }]} numberOfLines={1}>
          {selected?.label ?? placeholder}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.modalSheet} onPress={() => undefined}>
            <Text style={[typography.subheading, styles.modalTitle]}>{label ?? 'Select an option'}</Text>
            <ScrollView contentContainerStyle={styles.optionList}>
              {options.length === 0 ? <Text style={typography.body}>No options available.</Text> : null}
              {options.map((option) => {
                const active = option.value === value;
                return (
                  <Pressable
                    key={String(option.value)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [styles.option, active && styles.optionActive, pressed && { opacity: 0.8 }]}
                  >
                    <View style={styles.flex}>
                      <Text style={[typography.body, { color: colors.textPrimary }]}>{option.label}</Text>
                      {option.description ? <Text style={typography.caption}>{option.description}</Text> : null}
                    </View>
                    {active ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

export function StatTile({ label, value, icon, tone = 'info', caption }: { label: string; value: string; icon: IconName; tone?: BadgeTone; caption?: string }) {
  const palette = BADGE_TONES[tone];
  return (
    <GlassCard style={styles.statTile}>
      <View style={[styles.statIcon, { backgroundColor: palette.background }]}>
        <Ionicons name={icon} size={18} color={palette.color} />
      </View>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={typography.caption}>{label}</Text>
      {caption ? <Text style={[typography.caption, { marginTop: 2 }]}>{caption}</Text> : null}
    </GlassCard>
  );
}

export function Banner({ tone, message, title }: { tone: BadgeTone; message: string; title?: string }) {
  const palette = BADGE_TONES[tone];
  return (
    <View style={[styles.banner, { backgroundColor: palette.background, borderColor: palette.color }]} accessibilityLiveRegion="polite">
      <Ionicons name={palette.icon} size={18} color={palette.color} />
      <View style={styles.flex}>
        {title ? <Text style={[typography.subheading, { color: palette.color }]}>{title}</Text> : null}
        <Text style={[typography.body, { color: colors.textPrimary }]}>{message}</Text>
      </View>
    </View>
  );
}

export function KeyValue({ label, value, valueTone }: { label: string; value: string; valueTone?: BadgeTone }) {
  return (
    <View style={styles.keyValue}>
      <Text style={[typography.body, styles.flex]}>{label}</Text>
      <Text style={[typography.tabular, valueTone ? { color: BADGE_TONES[valueTone].color } : null]}>{value}</Text>
    </View>
  );
}

export function EmptyState({ icon, title, message, action }: { icon: IconName; title: string; message: string; action?: ReactNode }) {
  return (
    <GlassCard style={styles.empty}>
      <Ionicons name={icon} size={36} color={colors.textMuted} />
      <Text style={typography.subheading}>{title}</Text>
      <Text style={[typography.body, styles.centerText]}>{message}</Text>
      {action}
    </GlassCard>
  );
}

export function Chip({ label, active, onPress, icon }: { label: string; active?: boolean; onPress: () => void; icon?: IconName }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(active) }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive]}
    >
      {icon ? <Ionicons name={icon} size={14} color={active ? '#ffffff' : colors.textSecondary} /> : null}
      <Text style={[styles.chipLabel, active && { color: '#ffffff' }]}>{label}</Text>
    </Pressable>
  );
}

export function LoadingOverlay({ visible, message }: { visible: boolean; message: string }) {
  if (!visible) {
    return null;
  }
  return (
    <View style={[StyleSheet.absoluteFill, styles.modalBackdrop]} accessibilityViewIsModal accessibilityLiveRegion="polite">
      <GlassCard style={styles.loadingCard}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[typography.body, styles.centerText]}>{message}</Text>
      </GlassCard>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: {
    backgroundColor: colors.glass,
    borderColor: colors.glassBorder,
    borderWidth: 1,
    borderRadius: radius.lg,
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  cardPadding: { padding: spacing.lg, gap: spacing.md },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  subtitle: { marginTop: 2 },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  buttonCompact: { minHeight: 38, paddingHorizontal: spacing.md },
  buttonLabel: { fontSize: 15, fontWeight: '700' },
  buttonLabelCompact: { fontSize: 13 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  badgeLabel: { fontSize: 12, fontWeight: '700' },
  field: { gap: 6 },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.inputBackground,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 96, paddingTop: spacing.md, textAlignVertical: 'top' },
  inputError: { borderColor: colors.danger },
  errorText: { color: colors.danger, fontSize: 12 },
  select: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    backgroundColor: colors.inputBackground,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  selectCompact: { minHeight: 40 },
  selectText: { flex: 1, color: colors.textPrimary, fontSize: 14 },
  modalBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'center', padding: spacing.xl },
  modalSheet: {
    backgroundColor: colors.glassStrong,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.lg,
    maxHeight: '80%',
  },
  modalTitle: { marginBottom: spacing.md },
  optionList: { gap: spacing.xs },
  option: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: radius.sm, gap: spacing.sm },
  optionActive: { backgroundColor: colors.primarySoft },
  statTile: { flex: 1, minWidth: 140, gap: spacing.xs },
  statIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  banner: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, alignItems: 'flex-start' },
  keyValue: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 6 },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  centerText: { textAlign: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glassHighlight,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  loadingCard: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder },
});
