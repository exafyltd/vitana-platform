-- no plan(): a file that never says how many tests it runs cannot pass.
SELECT ok(true, 'a test without a plan');
