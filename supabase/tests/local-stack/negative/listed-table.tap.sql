-- live_rooms is in not-replayable.txt: a claim that needs it must FAIL, not pass.
SELECT plan(1);
SELECT require_table('live_rooms', 'isolation claim on live_rooms');
SELECT * FROM finish();
