import { getSupabase } from './supabase';

export interface OasisTask {
    id: string;
    vtid: string;
    title: string;
    status: "OPEN" | "IN_PROGRESS" | "COMPLETED";
    updatedAt: string; // ISO timestamp
}

export async function listOasisTasks(limit: number = 50): Promise<OasisTask[]> {
    const supabase = getSupabase();
    if (!supabase) {
        console.error("Supabase client not available");
        return [];
    }

    // Query the vtid_ledger table
    // We order by updated_at desc to get the most recent tasks
    const { data, error } = await supabase
        .from('vtid_ledger')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(limit);

    if (error) {
        console.error("Error fetching OASIS tasks:", error);
        throw new Error(`Failed to fetch tasks: ${error.message}`);
    }

    if (!data) {
        return [];
    }

    // Map the database rows to the OasisTask interface
    return data.map((row: any) => {
        // Map status: ensure it's one of the allowed values, default to OPEN if unknown
        let status: "OPEN" | "IN_PROGRESS" | "COMPLETED" = "OPEN";
        if (row.status === "IN_PROGRESS" || row.status === "COMPLETED") {
            status = row.status;
        } else if (row.status === "DONE") {
            status = "COMPLETED";
        }

        // Ensure we have a title
        const title = row.title || `Task ${row.vtid}`;

        return {
            id: row.id ? String(row.id) : row.vtid, // Use row.id if available, else vtid
            vtid: row.vtid,
            title: title,
            status: status,
            updatedAt: row.updated_at || new Date().toISOString(),
        };
    });
}
