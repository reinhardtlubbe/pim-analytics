import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppButton, Banner, GlassCard, TextField } from '../components/ui';
import { Screen } from '../components/Screen';
import { APP_CONFIG } from '../config/appConfig';
import { toStructuredError } from '../services/errors';
import { useApp } from '../state/AppProvider';
import { colors, spacing, typography } from '../ui/theme';

export function LoginScreen() {
  const { signIn } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const submit = async () => {
    const nextErrors: { email?: string; password?: string } = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      nextErrors.email = 'Enter a valid email address.';
    }
    if (!password) {
      nextErrors.password = 'Enter your password.';
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (caught) {
      setError(toStructuredError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  const fillDemoCredentials = () => {
    setEmail(APP_CONFIG.demoAdmin.email);
    setPassword(APP_CONFIG.demoAdmin.password);
    setFieldErrors({});
  };

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} contentStyle={styles.content}>
      <View style={styles.brand}>
        <View style={styles.logo}>
          <Ionicons name="planet" size={30} color="#ffffff" />
        </View>
        <Text style={typography.title}>PlanIt Media</Text>
        <Text style={[typography.body, styles.center]}>Mobile Edition · campaign data workspace</Text>
      </View>

      <GlassCard>
        <Text style={typography.heading}>Sign in to your workspace</Text>
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          placeholder="name@company.com"
          error={fieldErrors.email}
          returnKeyType="next"
        />
        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          textContentType="password"
          placeholder="Password"
          error={fieldErrors.password}
          onSubmitEditing={submit}
          returnKeyType="go"
        />
        <AppButton
          label={showPassword ? 'Hide password' : 'Show password'}
          variant="ghost"
          compact
          icon={showPassword ? 'eye-off' : 'eye'}
          onPress={() => setShowPassword((value) => !value)}
          style={styles.alignStart}
        />
        {error ? <Banner tone="danger" message={error} /> : null}
        <AppButton label="Sign in" icon="log-in" onPress={submit} loading={busy} />
      </GlassCard>

      <GlassCard>
        <View style={styles.row}>
          <Ionicons name="flask" size={18} color={colors.warning} />
          <Text style={typography.subheading}>Evaluation access</Text>
        </View>
        <Text style={typography.body}>
          Demo administrator: {APP_CONFIG.demoAdmin.email} / {APP_CONFIG.demoAdmin.password}
        </Text>
        <Text style={typography.caption}>
          These credentials exist for evaluator testing only. Sign-in is verified on this device against a salted PBKDF2 hash in the local SQLite database; it is
          not a production multi-device identity system, which would need a trusted authentication server and server-side access control.
        </Text>
        <AppButton label="Fill demo credentials" variant="secondary" icon="key" onPress={fillDemoCredentials} />
      </GlassCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: 'center', flexGrow: 1 },
  brand: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.primary,
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 8,
  },
  center: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  alignStart: { alignSelf: 'flex-start' },
});
