export interface SystemControl {
  key: string;
  enabled: boolean;
  updated_at: string;
  updated_by?: string | null;
  reason?: string | null;
}