import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE credentials');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function checkMemory() {
  const email = 'd.stevanovic@exafy.io';

  // Find user by email
  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, tenant_id, email')
    .eq('email', email)
    .single();

  if (profileError || !profiles) {
    console.error('User not found:', profileError?.message);
    return;
  }

  console.log('User found:', { id: profiles.id, tenant_id: profiles.tenant_id, email: profiles.email });

  // Check memory_facts
  const { data: facts, error: factsError } = await supabase
    .from('memory_facts')
    .select('*')
    .eq('user_id', profiles.id)
    .eq('tenant_id', profiles.tenant_id)
    .is('superseded_by', null)
    .order('extracted_at', { ascending: false })
    .limit(20);

  console.log('\n=== MEMORY_FACTS (current) ===');
  if (factsError) {
    console.error('Error:', factsError.message);
  } else if (!facts || facts.length === 0) {
    console.log('❌ NO FACTS FOUND');
  } else {
    console.log(`✅ Found ${facts.length} facts:`);
    facts.forEach(f => {
      console.log(`  - ${f.fact_key}: ${f.fact_value} (${f.provenance_source}, confidence: ${f.provenance_confidence})`);
    });
  }

  // Check memory_items
  const { data: items, error: itemsError } = await supabase
    .from('memory_items')
    .select('id, category_key, content, importance, occurred_at, source')
    .eq('user_id', profiles.id)
    .eq('tenant_id', profiles.tenant_id)
    .order('occurred_at', { ascending: false })
    .limit(10);

  console.log('\n=== MEMORY_ITEMS (recent) ===');
  if (itemsError) {
    console.error('Error:', itemsError.message);
  } else if (!items || items.length === 0) {
    console.log('❌ NO ITEMS FOUND');
  } else {
    console.log(`✅ Found ${items.length} items (showing first 10):`);
    items.forEach(i => {
      console.log(`  - [${i.category_key}] ${i.content.substring(0, 100)}... (${i.occurred_at})`);
    });
  }

  // Check oasis_events for extraction
  const { data: events, error: eventsError } = await supabase
    .from('oasis_events')
    .select('type, message, created_at, payload')
    .like('type', '%memory%')
    .order('created_at', { ascending: false })
    .limit(10);

  console.log('\n=== OASIS_EVENTS (memory-related) ===');
  if (eventsError) {
    console.error('Error:', eventsError.message);
  } else if (!events || events.length === 0) {
    console.log('⚠️  NO MEMORY EVENTS FOUND');
  } else {
    console.log(`Found ${events.length} recent memory events:`);
    events.forEach(e => {
      console.log(`  - ${e.created_at}: ${e.type} - ${e.message}`);
    });
  }
}

checkMemory().catch(console.error);
