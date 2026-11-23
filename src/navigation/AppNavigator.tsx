import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, NavigationContainer, Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { GradientBackground } from '../components/Screen';
import { AppButton, Banner } from '../components/ui';
import { AdminGate } from './AdminGate';
import { ClientsAccountsScreen, CurrencyRatesScreen, UsersScreen } from '../screens/AdminScreens';
import { CalculatorScreen } from '../screens/CalculatorScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { HistoryScreen, LogsScreen, RunDetailScreen } from '../screens/HistoryScreens';
import { LoginScreen } from '../screens/LoginScreen';
import { MappingScreen } from '../screens/MappingScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { ProcessingScreen } from '../screens/ProcessingScreen';
import { ProfileEditorScreen, ProfilesScreen } from '../screens/ProfileScreens';
import { QuarantineDetailScreen, QuarantineScreen } from '../screens/QuarantineScreens';
import { ResultsScreen } from '../screens/ResultsScreen';
import { ScenarioCompareScreen, ScenariosScreen } from '../screens/ScenarioScreens';
import { UploadScreen } from '../screens/UploadScreen';
import { useApp } from '../state/AppProvider';
import { colors, typography } from '../ui/theme';
import { MainTabParamList, RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.primary,
    background: colors.backgroundTop,
    card: colors.backgroundTop,
    text: colors.textPrimary,
    border: colors.glassBorder,
    notification: colors.warning,
  },
};

const headerOptions = {
  headerStyle: { backgroundColor: colors.backgroundTop },
  headerTintColor: colors.textPrimary,
  headerTitleStyle: { fontWeight: '700' as const },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.backgroundTop },
};

const TAB_ICONS: Record<keyof MainTabParamList, keyof typeof Ionicons.glyphMap> = {
  Dashboard: 'grid',
  Upload: 'cloud-upload',
  Results: 'stats-chart',
  Calculator: 'calculator',
  More: 'ellipsis-horizontal-circle',
};

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        ...headerOptions,
        tabBarStyle: { backgroundColor: 'rgba(11, 15, 25, 0.96)', borderTopColor: colors.glassBorder },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarIcon: ({ color, size }) => <Ionicons name={TAB_ICONS[route.name]} size={size} color={color} />,
        sceneStyle: { backgroundColor: colors.backgroundTop },
      })}
    >
      <Tabs.Screen name="Dashboard" component={DashboardScreen} />
      <Tabs.Screen name="Upload" component={UploadScreen} />
      <Tabs.Screen name="Results" component={ResultsScreen} />
      <Tabs.Screen name="Calculator" component={CalculatorScreen} options={{ title: 'Budget' }} />
      <Tabs.Screen name="More" component={MoreScreen} />
    </Tabs.Navigator>
  );
}

function StartupScreen() {
  const { status, initError, retryInitialization } = useApp();
  return (
    <GradientBackground>
      <View style={styles.centered}>
        {status === 'error' ? (
          <>
            <Banner tone="danger" title="The database could not be opened" message={initError ?? 'Unknown error'} />
            <AppButton label="Try again" icon="refresh" onPress={retryInitialization} />
          </>
        ) : (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={typography.body}>Opening the local database…</Text>
          </>
        )}
      </View>
    </GradientBackground>
  );
}

export function AppNavigator() {
  const { status, actor } = useApp();
  if (status !== 'ready') {
    return <StartupScreen />;
  }
  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator screenOptions={headerOptions}>
        {actor ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
            <Stack.Screen name="Mapping" component={MappingScreen} options={{ title: 'Field mapping' }} />
            <Stack.Screen name="Processing" component={ProcessingScreen} options={{ title: 'Processing', gestureEnabled: false }} />
            <Stack.Screen name="History" component={HistoryScreen} options={{ title: 'Processing history' }} />
            <Stack.Screen name="RunDetail" component={RunDetailScreen} options={{ title: 'Run details' }} />
            <Stack.Screen name="Quarantine" component={QuarantineScreen} options={{ title: 'Validation & quarantine' }} />
            <Stack.Screen name="QuarantineDetail" component={QuarantineDetailScreen} options={{ title: 'Quarantined row' }} />
            <Stack.Screen name="Profiles" component={ProfilesScreen} options={{ title: 'Mapping profiles' }} />
            <Stack.Screen name="ProfileEditor" component={ProfileEditorScreen} options={{ title: 'Mapping profile' }} />
            <Stack.Screen name="Scenarios" component={ScenariosScreen} options={{ title: 'Saved scenarios' }} />
            <Stack.Screen name="ScenarioCompare" component={ScenarioCompareScreen} options={{ title: 'Compare scenarios' }} />
            <Stack.Screen name="Logs" component={LogsScreen} options={{ title: 'Audit log' }} />
            <Stack.Screen name="ClientsAccounts" options={{ title: 'Clients & accounts' }}>
              {() => (
                <AdminGate permission="reference.manage">
                  <ClientsAccountsScreen />
                </AdminGate>
              )}
            </Stack.Screen>
            <Stack.Screen name="Users" options={{ title: 'Users & roles' }}>
              {() => (
                <AdminGate permission="users.manage">
                  <UsersScreen />
                </AdminGate>
              )}
            </Stack.Screen>
            <Stack.Screen name="CurrencyRates" options={{ title: 'Currency rates' }}>
              {() => (
                <AdminGate permission="currency.manage">
                  <CurrencyRatesScreen />
                </AdminGate>
              )}
            </Stack.Screen>
          </>
        ) : (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
});
