#!/usr/bin/env node
/**
 * Test script to create a live room and verify Daily.co integration
 * Usage: GATEWAY_URL=https://... SUPABASE_JWT=xxx node test-daily-room-creation.mjs
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-86804897789.us-central1.run.app';
const SUPABASE_JWT = process.env.SUPABASE_JWT; // User must provide a valid JWT

if (!SUPABASE_JWT) {
  console.error('❌ Error: SUPABASE_JWT environment variable is required');
  console.error('   Get a JWT from Supabase Auth or use the service role token');
  process.exit(1);
}

async function createRoom() {
  console.log('🚀 Creating live room...');
  console.log(`   Gateway: ${GATEWAY_URL}`);

  const roomData = {
    title: `Test Room ${Date.now()}`,
    topic_keys: ['test', 'daily-verification'],
    starts_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    access_level: 'public',
    metadata: {
      test: true,
      created_by_script: true
    }
  };

  try {
    const response = await fetch(`${GATEWAY_URL}/api/v1/live/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_JWT}`
      },
      body: JSON.stringify(roomData)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Room creation failed: ${response.status} ${response.statusText}`);
      console.error(`   Response: ${error}`);
      return null;
    }

    const result = await response.json();
    console.log('✅ Room created successfully!');
    console.log(`   Room ID: ${result.room.id}`);
    console.log(`   Title: ${result.room.title}`);
    console.log(`   Status: ${result.room.status}`);

    return result.room;
  } catch (err) {
    console.error('❌ Error creating room:', err.message);
    return null;
  }
}

async function createDailyRoom(roomId) {
  console.log('\n🎥 Creating Daily.co room...');

  try {
    const response = await fetch(`${GATEWAY_URL}/api/v1/live/rooms/${roomId}/daily`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_JWT}`
      }
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`❌ Daily.co room creation failed: ${response.status} ${response.statusText}`);
      console.error(`   Response: ${error}`);
      return null;
    }

    const result = await response.json();
    console.log('✅ Daily.co room created successfully!');
    console.log(`   Room URL: ${result.daily_room_url}`);
    console.log(`   Room Name: ${result.daily_room_name}`);
    console.log(`   Already Existed: ${result.already_existed}`);

    return result;
  } catch (err) {
    console.error('❌ Error creating Daily.co room:', err.message);
    return null;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Daily.co Integration Test');
  console.log('='.repeat(60));

  const room = await createRoom();
  if (!room) {
    console.error('\n❌ Test failed: Could not create room');
    process.exit(1);
  }

  const dailyRoom = await createDailyRoom(room.id);
  if (!dailyRoom) {
    console.error('\n❌ Test failed: Could not create Daily.co room');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Test completed successfully!');
  console.log('='.repeat(60));
  console.log('\n📋 Summary:');
  console.log(`   Vitana Room ID: ${room.id}`);
  console.log(`   Daily.co URL: ${dailyRoom.daily_room_url}`);
  console.log(`   Daily.co Name: ${dailyRoom.daily_room_name}`);
  console.log('\n🔍 Next Steps:');
  console.log('   1. Check your Daily.co dashboard at https://dashboard.daily.co/rooms');
  console.log(`   2. Look for room: ${dailyRoom.daily_room_name}`);
  console.log('   3. Verify the room appears in the list');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
