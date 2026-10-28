#!/usr/bin/env node
/**
 * Check existing live rooms and their Daily.co integration status
 * This script queries the Supabase database to check room metadata
 *
 * Usage: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE=xxx node check-daily-rooms.mjs
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('❌ Error: Required environment variables:');
  console.error('   SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE');
  process.exit(1);
}

async function checkRooms() {
  console.log('🔍 Checking live rooms...');
  console.log(`   Database: ${SUPABASE_URL}`);

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/live_rooms?select=id,title,room_name,status,metadata,created_at&order=created_at.desc&limit=10`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Query failed: ${response.status} ${response.statusText}`);
      console.error(`   Response: ${error}`);
      return;
    }

    const rooms = await response.json();

    console.log(`\n📊 Found ${rooms.length} rooms:\n`);

    if (rooms.length === 0) {
      console.log('   No rooms found in database');
      return;
    }

    rooms.forEach((room, index) => {
      console.log(`${index + 1}. ${room.title || 'Untitled Room'}`);
      console.log(`   ID: ${room.id}`);
      console.log(`   Status: ${room.status}`);
      console.log(`   Room Name: ${room.room_name || 'N/A'}`);
      console.log(`   Created: ${room.created_at}`);

      // Check Daily.co metadata
      if (room.metadata && room.metadata.daily_room_url) {
        console.log(`   ✅ Daily.co URL: ${room.metadata.daily_room_url}`);
        console.log(`   ✅ Daily.co Name: ${room.metadata.daily_room_name}`);
      } else {
        console.log(`   ⚠️  No Daily.co integration found`);
      }
      console.log('');
    });

    // Summary
    const roomsWithDaily = rooms.filter(r => r.metadata?.daily_room_url).length;
    console.log('='.repeat(60));
    console.log(`📈 Summary:`);
    console.log(`   Total Rooms: ${rooms.length}`);
    console.log(`   With Daily.co: ${roomsWithDaily}`);
    console.log(`   Without Daily.co: ${rooms.length - roomsWithDaily}`);

    if (roomsWithDaily > 0) {
      console.log('\n✅ Daily.co integration is working!');
      console.log('   Rooms have been created in Daily.co');
    } else {
      console.log('\n⚠️  No Daily.co rooms found');
      console.log('   Either:');
      console.log('   1. No rooms have been created yet');
      console.log('   2. Daily.co integration hasn\'t been triggered (call POST /rooms/:id/daily)');
      console.log('   3. DAILY_API_KEY is not configured on the Gateway');
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

checkRooms().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
