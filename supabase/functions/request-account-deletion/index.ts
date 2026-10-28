import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Tables with user_id that do NOT cascade from auth.users.
//
// IMPORTANT: every table referencing auth.users with an ON DELETE rule of
// NO ACTION ("a") or RESTRICT ("r") will BLOCK `auth.admin.deleteUser` with a
// foreign-key violation unless its rows are removed here first. CASCADE ("c")
// and SET NULL ("n") tables are handled automatically by Postgres and do not
// need to be listed.
//
// Order matters: delete child rows before their parents.
const USER_TABLES_NO_CASCADE = [
  { table: "autopilot_feedback", column: "user_id" },
  { table: "autopilot_actions", column: "user_id" },
  { table: "automation_executions", column: "user_id" },
  { table: "ai_messages", column: "conversation_id", via: "ai_conversations" },
  { table: "ai_conversations", column: "user_id" },
  { table: "diary_entries", column: "user_id" },
  { table: "memberships", column: "user_id" },
  { table: "role_preferences", column: "user_id" },
  { table: "user_supplements", column: "user_id" },
  { table: "global_message_thread_reads", column: "user_id" },
  { table: "thread_reads", column: "user_id" },
  { table: "global_thread_participants", column: "user_id" },
  { table: "thread_participants", column: "user_id" },
  { table: "global_messages", column: "sender_id" },
  { table: "messages", column: "sender_id" },
  { table: "chat_messages", column: "sender_id" },
  { table: "event_rsvps", column: "user_id" },
  { table: "campaign_audience_segments", column: "user_id" },
  { table: "calendar_events", column: "user_id" },
  { table: "calendar_invite_responses", column: "user_id" },
  { table: "active_threads", column: "user_id" },
  { table: "anticipatory_guidance", column: "user_id" },
  { table: "autopilot_recommendations", column: "user_id" },
  // ── Wallet system (RESTRICT/NO ACTION on auth.users) ──
  // Added 2026-06: every user gets a wallet_account on signup, and its
  // user_id FK is ON DELETE RESTRICT, so deletion fails for ALL users unless
  // these are cleared first. Children (ledger entries, deposits) reference
  // wallet_accounts.account_id with NO ACTION, so they must go before it.
  { table: "wallet_ledger_entries", column: "user_id" },
  { table: "wallet_deposits", column: "user_id" },
  { table: "wallet_credits", column: "user_id" },
  { table: "wallet_accounts", column: "user_id" },
];

// Columns that reference auth.users via NO ACTION but point at records OWNED BY
// OTHER USERS (e.g. "who granted this role", "who created this integration").
// We must NOT delete those rows — just null the reference so the auth user can
// be removed. All of these columns are nullable.
const USER_REFERENCE_NULLABLE = [
  { table: "user_roles", column: "granted_by" },
  { table: "api_integrations", column: "created_by" },
  { table: "api_test_logs", column: "triggered_by" },
  { table: "feedback_tickets", column: "rolled_back_by" },
];

// Storage buckets where user files live under {userId}/ prefix
const USER_STORAGE_BUCKETS = [
  "avatars",
  "diary-photos",
  "chat-attachments",
  "media-uploads",
  "voucher-pdfs",
  "stream-recordings",
  "event-images",
];

async function deleteUserStorageFiles(
  serviceClient: any,
  userId: string
): Promise<{ bucket: string; deleted: number; error?: string }[]> {
  const results = [];

  for (const bucket of USER_STORAGE_BUCKETS) {
    try {
      // List all files under the user's folder
      const { data: files, error: listError } = await serviceClient.storage
        .from(bucket)
        .list(userId, { limit: 1000 });

      if (listError) {
        console.warn(`[Deletion] Could not list ${bucket}/${userId}:`, listError.message);
        results.push({ bucket, deleted: 0, error: listError.message });
        continue;
      }

      if (!files || files.length === 0) {
        results.push({ bucket, deleted: 0 });
        continue;
      }

      const filePaths = files.map((f: any) => `${userId}/${f.name}`);
      const { error: removeError } = await serviceClient.storage
        .from(bucket)
        .remove(filePaths);

      if (removeError) {
        console.warn(`[Deletion] Could not remove files from ${bucket}:`, removeError.message);
        results.push({ bucket, deleted: 0, error: removeError.message });
      } else {
        results.push({ bucket, deleted: filePaths.length });
      }
    } catch (e: any) {
      console.warn(`[Deletion] Storage cleanup error for ${bucket}:`, e.message);
      results.push({ bucket, deleted: 0, error: e.message });
    }
  }

  return results;
}

async function nullUserReferences(
  serviceClient: any,
  userId: string
): Promise<{ table: string; error?: string }[]> {
  const results = [];

  for (const entry of USER_REFERENCE_NULLABLE) {
    try {
      const { error } = await serviceClient
        .from(entry.table)
        .update({ [entry.column]: null })
        .eq(entry.column, userId);

      results.push({ table: `${entry.table}.${entry.column}`, error: error?.message });
    } catch (e: any) {
      console.warn(`[Deletion] Null ref ${entry.table}.${entry.column} error:`, e.message);
      results.push({ table: `${entry.table}.${entry.column}`, error: e.message });
    }
  }

  return results;
}

async function deleteUserTableData(
  serviceClient: any,
  userId: string
): Promise<{ table: string; error?: string }[]> {
  const results = [];

  for (const entry of USER_TABLES_NO_CASCADE) {
    try {
      if (entry.table === "ai_messages" && entry.via === "ai_conversations") {
        // Delete ai_messages by joining through ai_conversations
        const { data: convos } = await serviceClient
          .from("ai_conversations")
          .select("id")
          .eq("user_id", userId);

        if (convos && convos.length > 0) {
          const convoIds = convos.map((c: any) => c.id);
          const { error } = await serviceClient
            .from("ai_messages")
            .delete()
            .in("conversation_id", convoIds);
          results.push({ table: "ai_messages", error: error?.message });
        } else {
          results.push({ table: "ai_messages" });
        }
        continue;
      }

      const { error } = await serviceClient
        .from(entry.table)
        .delete()
        .eq(entry.column, userId);

      results.push({ table: entry.table, error: error?.message });
    } catch (e: any) {
      console.warn(`[Deletion] Table ${entry.table} error:`, e.message);
      results.push({ table: entry.table, error: e.message });
    }
  }

  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Validate caller identity with anon client
    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await anonClient.auth.getUser();
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = userData.user.id;

    // Parse optional reason
    let reason: string | null = null;
    try {
      const body = await req.json();
      reason = body?.reason || null;
    } catch {
      // No body is fine
    }

    // Use service role client for DB operations (bypasses RLS)
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Log the deletion request
    const { error: insertError } = await serviceClient
      .from("account_deletion_requests")
      .insert({ user_id: userId, reason, status: "processing" });

    if (insertError) {
      console.error("Failed to log deletion request:", insertError);
      return new Response(JSON.stringify({ error: "Failed to process request" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 1: Delete non-cascading table data ──
    console.log(`[Deletion] Deleting non-cascading table data for user ${userId}`);
    const tableResults = await deleteUserTableData(serviceClient, userId);
    const tableErrors = tableResults.filter((r) => r.error);
    if (tableErrors.length > 0) {
      console.warn("[Deletion] Some table deletions had errors:", tableErrors);
    }

    // ── Step 2: Null out references owned by other users (NO ACTION FKs) ──
    console.log(`[Deletion] Nulling cross-user references for user ${userId}`);
    const refResults = await nullUserReferences(serviceClient, userId);
    const refErrors = refResults.filter((r) => r.error);
    if (refErrors.length > 0) {
      console.warn("[Deletion] Some reference nulling had errors:", refErrors);
    }

    // ── Step 3: Delete storage files ──
    console.log(`[Deletion] Cleaning storage buckets for user ${userId}`);
    const storageResults = await deleteUserStorageFiles(serviceClient, userId);
    const storageErrors = storageResults.filter((r) => r.error);
    if (storageErrors.length > 0) {
      console.warn("[Deletion] Some storage cleanups had errors:", storageErrors);
    }

    // ── Step 4: Delete the auth user (cascades remaining FK tables) ──
    console.log(`[Deletion] Deleting auth user ${userId}`);
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);

    if (deleteError) {
      console.error("Failed to delete user:", deleteError);
      await serviceClient
        .from("account_deletion_requests")
        .update({ status: "failed", processed_at: new Date().toISOString() })
        .eq("user_id", userId);

      return new Response(
        JSON.stringify({ error: "Failed to delete account", detail: deleteError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Mark as completed
    await serviceClient
      .from("account_deletion_requests")
      .update({
        status: "completed",
        processed_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    console.log(`[Deletion] Account deletion completed for user ${userId}`);

    return new Response(
      JSON.stringify({
        ok: true,
        summary: {
          tables_cleaned: tableResults.length,
          table_errors: tableErrors.length,
          references_nulled: refResults.length,
          storage_buckets_cleaned: storageResults.filter((r) => r.deleted > 0).length,
          storage_files_deleted: storageResults.reduce((sum, r) => sum + r.deleted, 0),
        },
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Account deletion error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
