-- no finish(): the runner itself must notice that 1 test ran of 3 planned.
SELECT plan(3);
SELECT ok(true, 'only one test runs');
