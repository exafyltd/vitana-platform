module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  verbose: true,
  forceExit: true,
  globals: {
    'ts-jest': { isolatedModules: true },
  },
};
