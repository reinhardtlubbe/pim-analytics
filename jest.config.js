module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json', diagnostics: { warnOnly: false } }],
  },
  testTimeout: 30000,
};
