#!/usr/bin/env node
/**
 * Memory System Diagnostic Script
 * Investigates why memory isn't persisting/retrieving for a user
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
  console.error('Please set these environment variables and try again.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function diagnoseMemorySystem(userEmail) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`MEMORY SYSTEM DIAGNOSTIC - ${userEmail}`);
  console.log(`${'='.repeat(80)}\n`);

  // Step 1: Find user
  console.log('📋 Step 1: Looking up user...');
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, tenant_id, email, created_at')
    .eq('email', userEmail)
    .single();

  if (profileError || !profile) {
    console.error(`❌ User not found: ${profileError?.message || 'No profile returned'}`);
    return;
  }

  console.log(`✅ User found:`);
  console.log(`   - User ID: ${profile.id}`);
  console.log(`   - Tenant ID: ${profile.tenant_id}`);
  console.log(`   - Created: ${profile.created_at}\n`);

  const { id: userId, tenant_id: tenantId } = profile;

  // Step 2: Check memory_facts (VTID-01192 structured facts)
  console.log('📋 Step 2: Checking memory_facts (structured facts)...');
  const { data: facts, error: factsError } = await supabase
    .from('memory_facts')
    .select('id, fact_key, fact_value, entity, provenance_source, provenance_confidence, extracted_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .is('superseded_by', null)
    .order('extracted_at', { ascending: false })
    .limit(50);

  if (factsError) {
    console.error(`❌ Error querying memory_facts: ${factsError.message}\n`);
  } else if (!facts || facts.length === 0) {
    console.log(`❌ NO FACTS FOUND in memory_facts table`);
    console.log(`   This means:`);
    console.log(`   - Cognee extraction may be disabled`);
    console.log(`   - Cognee extraction may be failing`);
    console.log(`   - write_fact() RPC may be failing\n`);
  } else {
    console.log(`✅ Found ${facts.length} structured facts:\n`);
    facts.forEach((f, i) => {
      console.log(`   ${i + 1}. ${f.fact_key} = "${f.fact_value}"`);
      console.log(`      Entity: ${f.entity}, Source: ${f.provenance_source}, Confidence: ${f.provenance_confidence}`);
      console.log(`      Extracted: ${f.extracted_at}`);
    });
    console.log('');
  }

  // Step 3: Check memory_items (legacy full-text memory)
  console.log('📋 Step 3: Checking memory_items (legacy memory)...');
  const { data: items, error: itemsError } = await supabase
    .from('memory_items')
    .select('id, category_key, content, importance, source, occurred_at')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .order('occurred_at', { ascending: false })
    .limit(20);

  if (itemsError) {
    console.error(`❌ Error querying memory_items: ${itemsError.message}\n`);
  } else if (!items || items.length === 0) {
    console.log(`❌ NO ITEMS FOUND in memory_items table`);
    console.log(`   This means no conversations have been persisted to memory\n`);
  } else {
    console.log(`✅ Found ${items.length} memory items (showing first 20):\n`);
    items.slice(0, 10).forEach((item, i) => {
      console.log(`   ${i + 1}. [${item.category_key}] ${item.content.substring(0, 80)}...`);
      console.log(`      Source: ${item.source}, Importance: ${item.importance}, Occurred: ${item.occurred_at}`);
    });
    console.log('');
  }

  // Step 4: Check OASIS events for cognee extraction
  console.log('📋 Step 4: Checking OASIS events for Cognee extraction...');
  const { data: cogneeEvents, error: eventsError } = await supabase
    .from('oasis_events')
    .select('type, status, message, created_at, payload')
    .like('type', '%cognee%')
    .order('created_at', { ascending: false })
    .limit(20);

  if (eventsError) {
    console.error(`❌ Error querying oasis_events: ${eventsError.message}\n`);
  } else if (!cogneeEvents || cogneeEvents.length === 0) {
    console.log(`❌ NO COGNEE EXTRACTION EVENTS FOUND`);
    console.log(`   This strongly suggests Cognee extraction is DISABLED`);
    console.log(`   Check if COGNEE_EXTRACTOR_URL environment variable is set in Gateway\n`);
  } else {
    console.log(`✅ Found ${cogneeEvents.length} recent Cognee events:\n`);
    cogneeEvents.slice(0, 10).forEach((e, i) => {
      console.log(`   ${i + 1}. [${e.status}] ${e.type}`);
      console.log(`      ${e.message}`);
      console.log(`      ${e.created_at}`);
      if (e.payload) {
        console.log(`      Payload: ${JSON.stringify(e.payload).substring(0, 100)}...`);
      }
    });
    console.log('');
  }

  // Step 5: Check recent memory-related OASIS events
  console.log('📋 Step 5: Checking OASIS events for memory operations...');
  const { data: memoryEvents, error: memEventsError } = await supabase
    .from('oasis_events')
    .select('type, status, message, created_at, payload')
    .like('type', '%memory%')
    .order('created_at', { ascending: false })
    .limit(20);

  if (memEventsError) {
    console.error(`❌ Error querying memory events: ${memEventsError.message}\n`);
  } else if (!memoryEvents || memoryEvents.length === 0) {
    console.log(`⚠️  NO MEMORY EVENTS FOUND\n`);
  } else {
    console.log(`✅ Found ${memoryEvents.length} recent memory events:\n`);
    memoryEvents.slice(0, 10).forEach((e, i) => {
      console.log(`   ${i + 1}. [${e.status}] ${e.type}`);
      console.log(`      ${e.message}`);
      console.log(`      ${e.created_at}`);
    });
    console.log('');
  }

  // Step 6: Check relationship graph (nodes and edges)
  console.log('📋 Step 6: Checking relationship graph...');
  const { data: nodes, error: nodesError } = await supabase
    .from('relationship_nodes')
    .select('id, node_type, title, domain, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (nodesError) {
    console.error(`❌ Error querying relationship_nodes: ${nodesError.message}\n`);
  } else if (!nodes || nodes.length === 0) {
    console.log(`❌ NO RELATIONSHIP NODES FOUND`);
    console.log(`   This confirms Cognee extraction is not persisting data\n`);
  } else {
    console.log(`✅ Found ${nodes.length} relationship nodes:\n`);
    nodes.slice(0, 10).forEach((n, i) => {
      console.log(`   ${i + 1}. ${n.title} (${n.node_type}, ${n.domain})`);
      console.log(`      Created: ${n.created_at}`);
    });
    console.log('');
  }

  // Summary and recommendations
  console.log(`\n${'='.repeat(80)}`);
  console.log('DIAGNOSTIC SUMMARY');
  console.log(`${'='.repeat(80)}\n`);

  const hasFacts = facts && facts.length > 0;
  const hasItems = items && items.length > 0;
  const hasCogneeEvents = cogneeEvents && cogneeEvents.length > 0;
  const hasNodes = nodes && nodes.length > 0;

  if (!hasFacts && !hasItems && !hasCogneeEvents && !hasNodes) {
    console.log('🔴 CRITICAL ISSUE: NO MEMORY DATA FOUND AT ALL');
    console.log('\nLikely causes:');
    console.log('  1. COGNEE_EXTRACTOR_URL is not set in Gateway Cloud Run service');
    console.log('  2. User has never had a conversation through Gateway');
    console.log('  3. Memory persistence is completely broken');
    console.log('\nNext steps:');
    console.log('  1. Check Cloud Run environment variables for Gateway');
    console.log('  2. Verify user is actually using the Gateway API (not direct frontend)');
    console.log('  3. Check Gateway logs for extraction errors');
  } else if (!hasFacts && hasCogneeEvents) {
    console.log('🟡 WARNING: Cognee extraction is running but NOT persisting facts');
    console.log('\nLikely causes:');
    console.log('  1. write_fact() RPC is failing (check Supabase logs)');
    console.log('  2. Cognee extractor is returning empty results');
    console.log('  3. Persistence logic has bugs');
    console.log('\nNext steps:');
    console.log('  1. Check OASIS events for "cognee.extraction.persisted" failures');
    console.log('  2. Check Supabase logs for write_fact() RPC errors');
    console.log('  3. Review cognee-extractor-client.ts persistExtractionResults()');
  } else if (!hasFacts && !hasCogneeEvents) {
    console.log('🔴 CRITICAL: Cognee extraction is DISABLED or NOT RUNNING');
    console.log('\nLikely causes:');
    console.log('  1. COGNEE_EXTRACTOR_URL environment variable is not set');
    console.log('  2. Cognee extractor service is down');
    console.log('  3. Extraction is silently failing before HTTP call');
    console.log('\nNext steps:');
    console.log('  1. Set COGNEE_EXTRACTOR_URL in Gateway Cloud Run environment');
    console.log('  2. Deploy Cognee extractor service if not deployed');
    console.log('  3. Check Gateway logs for "Cognee Extractor URL not configured"');
  } else if (hasFacts) {
    console.log('🟢 Memory facts ARE being persisted correctly');
    console.log('\nPossible issues:');
    console.log('  1. Facts exist but are NOT being retrieved during conversation');
    console.log('  2. Context pack builder is not calling fetchMemoryFacts()');
    console.log('  3. Wrong user/tenant identity is being used for retrieval');
    console.log('\nNext steps:');
    console.log('  1. Add logging to context-pack-builder.ts fetchMemoryFacts()');
    console.log('  2. Verify identity (tenant_id/user_id) matches between write and read');
    console.log('  3. Check if formatContextPackForLLM() is including structured_facts');
  }

  console.log('\n');
}

// Run diagnostic
const userEmail = process.argv[2] || 'd.stevanovic@exafy.io';
diagnoseMemorySystem(userEmail).catch(console.error);
