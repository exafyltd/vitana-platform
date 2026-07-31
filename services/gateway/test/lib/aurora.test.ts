const mockPoolInstances: any[] = [];

jest.mock(
  'pg',
  () => {
    const Pool = jest.fn().mockImplementation((config: any) => {
      const instance = {
        config,
        connect: jest.fn(),
        on: jest.fn(),
      };
      mockPoolInstances.push(instance);
      return instance;
    });
    return { Pool };
  },
  { virtual: true }
);

describe('lib/aurora', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    mockPoolInstances.length = 0;
    process.env = { ...ORIGINAL_ENV };
    delete process.env.AURORA_DATABASE_URL;
    delete process.env.AURORA_POOL_MAX;
    delete process.env.AURORA_SSL_DISABLE;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns null and does not construct a Pool when AURORA_DATABASE_URL is unset', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { getAuroraPool } = require('../../src/lib/aurora');

    const pool = getAuroraPool();

    expect(pool).toBeNull();
    expect(mockPoolInstances).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('AURORA_DATABASE_URL not set'));
    errorSpy.mockRestore();
  });

  it('constructs a Pool with the connection string and default SSL enabled', () => {
    process.env.AURORA_DATABASE_URL = 'postgresql://user:pass@aurora-host:5432/vitana';
    const { getAuroraPool } = require('../../src/lib/aurora');

    const pool = getAuroraPool();

    expect(pool).not.toBeNull();
    expect(mockPoolInstances).toHaveLength(1);
    expect(mockPoolInstances[0].config).toMatchObject({
      connectionString: 'postgresql://user:pass@aurora-host:5432/vitana',
      ssl: { rejectUnauthorized: true },
    });
  });

  it('disables SSL only when AURORA_SSL_DISABLE=true', () => {
    process.env.AURORA_DATABASE_URL = 'postgresql://user:pass@aurora-host:5432/vitana';
    process.env.AURORA_SSL_DISABLE = 'true';
    const { getAuroraPool } = require('../../src/lib/aurora');

    getAuroraPool();

    expect(mockPoolInstances[0].config.ssl).toBe(false);
  });

  it('respects AURORA_POOL_MAX and defaults to 10 when unset', () => {
    process.env.AURORA_DATABASE_URL = 'postgresql://user:pass@aurora-host:5432/vitana';
    const { getAuroraPool } = require('../../src/lib/aurora');

    getAuroraPool();

    expect(mockPoolInstances[0].config.max).toBe(10);
  });

  it('returns the same singleton Pool instance across repeated calls', () => {
    process.env.AURORA_DATABASE_URL = 'postgresql://user:pass@aurora-host:5432/vitana';
    const { getAuroraPool } = require('../../src/lib/aurora');

    const first = getAuroraPool();
    const second = getAuroraPool();

    expect(first).toBe(second);
    expect(mockPoolInstances).toHaveLength(1);
  });
});
