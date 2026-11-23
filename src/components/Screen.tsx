import { LinearGradient } from 'expo-linear-gradient';
import { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing } from '../ui/theme';

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: ViewStyle;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  footer?: ReactNode;
  overlay?: ReactNode;
}

export function GradientBackground({ children }: { children: ReactNode }) {
  return (
    <LinearGradient colors={[colors.backgroundTop, colors.backgroundBottom]} style={styles.fill}>
      <View pointerEvents="none" style={styles.glowTop} />
      <View pointerEvents="none" style={styles.glowBottom} />
      {children}
    </LinearGradient>
  );
}

export function Screen({ children, scroll = true, refreshing, onRefresh, contentStyle, edges = ['left', 'right'], footer, overlay }: ScreenProps) {
  return (
    <GradientBackground>
      <SafeAreaView style={styles.fill} edges={edges}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {scroll ? (
            <ScrollView
              contentContainerStyle={[styles.content, contentStyle]}
              keyboardShouldPersistTaps="handled"
              refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
            >
              {children}
            </ScrollView>
          ) : (
            <View style={[styles.fill, styles.content, contentStyle]}>{children}</View>
          )}
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </KeyboardAvoidingView>
        {overlay}
      </SafeAreaView>
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassBorder,
    backgroundColor: colors.glassStrong,
  },
  glowTop: {
    position: 'absolute',
    top: -120,
    right: -80,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
  },
  glowBottom: {
    position: 'absolute',
    bottom: -140,
    left: -100,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: 'rgba(16, 185, 129, 0.06)',
  },
});
