import { NavigatorScreenParams } from '@react-navigation/native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

export type MainTabParamList = {
  Dashboard: undefined;
  Upload: undefined;
  Results: { runId?: number; fileId?: number; title?: string } | undefined;
  Calculator: { scenarioId?: number } | undefined;
  More: undefined;
};

export type RootStackParamList = {
  Login: undefined;
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Mapping: { fileId: number };
  Processing: { fileId: number; confirmationId: number };
  History: undefined;
  RunDetail: { runId: number };
  Quarantine: { runId?: number } | undefined;
  QuarantineDetail: { quarantineId: number };
  Profiles: undefined;
  ProfileEditor: { profileId?: number };
  Scenarios: undefined;
  ScenarioCompare: { scenarioIds: number[] };
  Logs: { runId?: number } | undefined;
  ClientsAccounts: undefined;
  Users: undefined;
  CurrencyRates: undefined;
};

export type RootScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;
