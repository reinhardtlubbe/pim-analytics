export interface SupplierRow {
  supplier_id: number;
  supplier_code: string;
  supplier_name: string;
  default_platform: string;
  default_currency: string | null;
  click_metric_type: string;
  is_active: number;
  metadata_json: string;
  created_at: string;
}

export interface ClientRow {
  client_id: number;
  client_name: string;
  industry: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface AccountRow {
  account_id: number;
  client_id: number;
  supplier_id: number;
  account_name: string;
  external_account_id: string;
  metadata_json: string;
  created_at: string;
}

export interface AccountView extends AccountRow {
  client_name: string;
  supplier_name: string;
  supplier_code: string;
}

export type FileStatus = 'registered' | 'mapped' | 'processing' | 'processed' | 'failed';

export interface UploadedFileRow {
  file_id: number;
  account_id: number;
  supplier_id: number;
  original_filename: string;
  stored_filename: string;
  stored_uri: string;
  file_type: 'csv' | 'xlsx';
  content_type: string | null;
  file_size_bytes: number;
  file_hash: string;
  record_count: number;
  total_rows: number;
  summary_rows: number;
  blank_rows: number;
  header_row_number: number;
  worksheet_name: string | null;
  worksheet_names_json: string;
  source_columns_json: string;
  detected_supplier_code: string | null;
  status: FileStatus;
  uploaded_by: number | null;
  upload_date: string;
}

export interface UploadedFileView extends UploadedFileRow {
  account_name: string;
  client_id: number;
  client_name: string;
  supplier_name: string;
  supplier_code: string;
  latest_run_id: number | null;
  latest_run_status: string | null;
  latest_confirmation_id: number | null;
}

export interface MappingProfileRow {
  profile_id: number;
  supplier_id: number;
  profile_name: string;
  file_type: 'csv' | 'xlsx';
  column_mappings_json: string;
  source_columns_json: string;
  header_row_number: number;
  worksheet_name: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface MappingConfirmationRow {
  confirmation_id: number;
  file_id: number;
  source_file_hash: string;
  supplier_name: string;
  profile_id: number | null;
  profile_name: string | null;
  source_columns_json: string;
  column_mappings_json: string;
  supplier_defaults_json: string;
  header_row_number: number;
  worksheet_name: string | null;
  confirmed_by: number | null;
  confirmed_at: string;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'superseded';

export interface ProcessingRunRow {
  run_id: number;
  file_id: number;
  confirmation_id: number;
  status: RunStatus;
  is_active: number;
  total_rows: number;
  blank_rows: number;
  summary_rows: number;
  detail_rows: number;
  accepted_rows: number;
  rejected_rows: number;
  duplicate_rows: number;
  potential_duplicate_rows: number;
  missing_click_rows: number;
  duration_ms: number | null;
  error_message: string | null;
  started_by: number | null;
  started_at: string;
  completed_at: string | null;
}

export interface ProcessingRunView extends ProcessingRunRow {
  original_filename: string;
  account_name: string;
  client_name: string;
  supplier_name: string;
}

export interface MediaRecordRow {
  record_id: number;
  run_id: number;
  file_id: number;
  source_row_number: number;
  report_month: string;
  client_id: number;
  client_name: string;
  account_id: number;
  account_name: string;
  supplier_id: number;
  platform: string;
  campaign_name: string | null;
  ad_group_name: string | null;
  placement: string | null;
  source_objective: string;
  campaign_type: string;
  spend_original: number;
  spend_zar: number | null;
  fx_rate: number | null;
  fx_rate_date: string | null;
  impressions: number;
  clicks: number | null;
  conversions: number | null;
  click_metric_type: string;
  currency: string;
  source_data_json: string;
  row_fingerprint: string;
  business_key: string;
  duplicate_flag: 'distinct' | 'potential_business_key';
  forecast_eligibility: string;
  created_at: string;
}

export interface ValidationErrorRow {
  error_id: number;
  run_id: number;
  source_row_number: number;
  field_name: string | null;
  error_type: string;
  severity: 'error' | 'warning';
  error_message: string;
  created_at: string;
}

export type QuarantineStatus = 'pending_review' | 'resolved' | 'dismissed';

export interface QuarantinedRecordRow {
  quarantine_id: number;
  run_id: number;
  source_row_number: number;
  source_data_json: string;
  reason: string;
  reason_type: 'validation' | 'exact_duplicate';
  status: QuarantineStatus;
  corrected_data_json: string | null;
  resolved_record_id: number | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface ProcessingLogRow {
  log_id: number;
  run_id: number | null;
  file_id: number | null;
  user_id: number | null;
  event_type: string;
  entity_type: string | null;
  entity_id: number | null;
  message: string;
  severity: 'info' | 'warning' | 'error';
  created_at: string;
}

export interface CurrencyRateRow {
  rate_id: number;
  currency_code: string;
  rate_to_zar: number;
  rate_date: string;
  source: string;
  created_at: string;
}

export interface ForecastScenarioRow {
  scenario_id: number;
  scenario_name: string;
  client_id: number;
  account_id: number | null;
  target_month: string;
  total_budget_zar: number;
  baseline_window: 3 | 6 | 12;
  allocation_mode: 'recommended' | 'manual';
  scenario_parameters_json: string;
  results_json: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface ForecastAllocationRow {
  allocation_id: number;
  scenario_id: number;
  allocation_type: 'recommended' | 'manual';
  platform: string;
  campaign_type: string;
  allocation_percentage: number;
  allocated_budget_zar: number;
  projected_clicks: number | null;
  projected_impressions: number | null;
  projected_conversions: number | null;
  projected_cpc: number | null;
}

export interface UserRow {
  user_id: number;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  is_active: number;
  is_demo_account: number;
  failed_login_count: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}
