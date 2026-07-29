export const EXTERNAL_AUTH_PROVIDERS = [
  "wechat",
  "douyin",
] as const;

export const AUTH_PROVIDERS = [
  ...EXTERNAL_AUTH_PROVIDERS,
  "dev",
] as const;

export type AuthProvider = typeof AUTH_PROVIDERS[number];
export type ExternalAuthProvider =
  typeof EXTERNAL_AUTH_PROVIDERS[number];

export const PROVIDER_FAILURE_REASONS = [
  "invalid_code",
  "invalid_credentials",
  "rate_limited",
  "timeout",
  "unavailable",
  "circuit_open",
  "invalid_response",
] as const;

export type ProviderFailureReason =
  typeof PROVIDER_FAILURE_REASONS[number];

export type ProviderRequestDurationRecorder = (
  durationMs: number,
) => void;

export type AuthExchangeResult<
  Provider extends ExternalAuthProvider = ExternalAuthProvider,
> =
  | {
      readonly ok: true;
      readonly provider: Provider;
      readonly providerAppId: string;
      readonly subject: string;
      readonly unionSubject: string | null;
      readonly sessionKey?: string;
      readonly providerVersion?: number;
      readonly providerLatencyMs?: number;
    }
  | {
      readonly ok: false;
      readonly reason: ProviderFailureReason;
      readonly providerVersion?: number;
      readonly providerLatencyMs?: number;
    };

export interface IdentityProviderClient<
  Provider extends ExternalAuthProvider = ExternalAuthProvider,
> {
  readonly provider: Provider;
  exchange(
    code: string,
    recordRequestDuration?: ProviderRequestDurationRecorder,
  ): Promise<AuthExchangeResult<Provider>>;
}
