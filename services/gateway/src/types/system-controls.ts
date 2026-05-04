export interface SystemControl {
  key: string;
  enabled: boolean;
  updated_at?: string | null;
  updated_by?: string | null;
  reason?: string | null;
}