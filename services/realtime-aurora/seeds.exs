# Vitana replacement for supabase/realtime v2.134.10 priv/repo/seeds.exs
# (VTID-05023, plan part 7a). run.sh evaluates it on every start when
# SEED_SELF_HOST=true, via Realtime.Release.seeds/1.
#
# Differences from upstream, all deliberate:
#   * the tenant's jwt_secret comes from TENANT_JWT_SECRET (the Supabase JWT
#     secret), never from API_JWT_SECRET. Upstream reuses API_JWT_SECRET, and
#     the management API (/api/tenants, signature-only check in
#     RealtimeWeb.Router.check_auth/2) would then accept any member token and
#     the public anon key. Refuses to start when the two are equal.
#   * the tenant name is required (SELF_HOST_TENANT_NAME), no "realtime-dev"
#     default: it must equal the first DNS label of the public host
#     (Realtime.Database.get_external_id/1), "realtime" for
#     realtime.vitanaland.com.
#   * ssl_enforced for the tenant's CDC connection comes from TENANT_DB_SSL
#     (default true; upstream hardcodes false). Aurora clients here use TLS.
#   * no DB defaults: DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD are required.
#   * upsert instead of delete + insert: an existing tenant row is updated in
#     place, so a restart does not drop and recreate the tenant.
require Logger

alias Realtime.Api
alias Realtime.Api.Tenant
alias Realtime.Repo
alias Realtime.Tenants

fetch! = fn name ->
  case System.get_env(name) do
    value when is_binary(value) and value != "" -> value
    _ -> raise "seeds.exs: #{name} must be set"
  end
end

tenant_name = fetch!.("SELF_HOST_TENANT_NAME")
tenant_jwt_secret = fetch!.("TENANT_JWT_SECRET")

if String.contains?(tenant_name, "."),
  do: raise("seeds.exs: SELF_HOST_TENANT_NAME must be a single DNS label, got #{inspect(tenant_name)}")

if System.get_env("API_JWT_SECRET") in [nil, "", tenant_jwt_secret],
  do: raise("seeds.exs: API_JWT_SECRET must be set and differ from TENANT_JWT_SECRET")

if byte_size(tenant_jwt_secret) < 32,
  do: raise("seeds.exs: TENANT_JWT_SECRET is shorter than 32 bytes")

ssl_enforced = System.get_env("TENANT_DB_SSL", "true") != "false"

{:ok, _flag} = Api.upsert_feature_flag(%{name: "gcm_encryption_backfill", enabled: true})

attrs = %{
  "name" => tenant_name,
  "external_id" => tenant_name,
  "jwt_secret" => tenant_jwt_secret,
  "extensions" => [
    %{
      "type" => "postgres_cdc_rls",
      "settings" => %{
        "db_name" => fetch!.("DB_NAME"),
        "db_host" => fetch!.("DB_HOST"),
        "db_user" => fetch!.("DB_USER"),
        "db_password" => fetch!.("DB_PASSWORD"),
        "db_port" => fetch!.("DB_PORT"),
        # Upstream's self-host value; only used to pick a node by region,
        # which a single-region deployment never does.
        "region" => "us-east-1",
        "poll_interval_ms" => 100,
        "poll_max_record_bytes" => 1_048_576,
        "ssl_enforced" => ssl_enforced
      }
    }
  ]
}

{:ok, _} =
  Repo.transaction(fn ->
    case Repo.get_by(Tenant, external_id: tenant_name) do
      %Tenant{} = existing ->
        existing
        |> Repo.preload(:extensions)
        |> Tenant.changeset(attrs)
        |> Repo.update!()

      nil ->
        %Tenant{}
        |> Tenant.changeset(attrs)
        |> Repo.insert!()
    end
  end)

tenant = Tenants.get_tenant_by_external_id(tenant_name)

with res when res in [:noop, :ok] <- Tenants.Migrations.run_migrations(tenant),
     :ok <- Tenants.Janitor.MaintenanceTask.run(tenant.external_id) do
  Logger.info("Tenant #{tenant_name} set up successfully (ssl_enforced=#{ssl_enforced})")
else
  error ->
    # Fail the start: a tenant whose migrations did not run cannot serve
    # postgres_changes, and a task that looks healthy but is not would hide it.
    raise "seeds.exs: failed to set up tenant #{tenant_name}: #{inspect(error)}"
end
