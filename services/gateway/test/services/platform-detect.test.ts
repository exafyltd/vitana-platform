/**
 * Storefront platform detection (VTID-03601). The load-bearing assertions
 * are the SSRF guard ones — a merchant-supplied URL must never let this
 * endpoint be used to probe internal/private addresses — plus the
 * fingerprint matching that actually delivers the feature.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { detectPlatform } from '../../src/services/platform-detect';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));

const mockLookup = dnsLookup as jest.Mock;

function mockFetchOnce(body: string, init: ResponseInit = {}) {
  (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(body, { status: 200, ...init }));
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]); // public by default
});

describe('input validation', () => {
  test('rejects an invalid URL', async () => {
    const result = await detectPlatform('not a url');
    expect(result).toEqual({ ok: false, error: 'invalid_url' });
  });

  test('rejects non-http(s) protocols', async () => {
    const result = await detectPlatform('ftp://example.com/store');
    expect(result).toEqual({ ok: false, error: 'unsupported_protocol' });
  });

  test('rejects file:// URLs', async () => {
    const result = await detectPlatform('file:///etc/passwd');
    expect(result.ok).toBe(false);
  });
});

describe('SSRF guard', () => {
  test('rejects a raw private IPv4 literal without needing a DNS lookup', async () => {
    const result = await detectPlatform('http://169.254.169.254/latest/meta-data/');
    expect(result).toEqual({ ok: false, error: 'blocked_private_address' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  test('rejects loopback', async () => {
    const result = await detectPlatform('http://127.0.0.1:8080/');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('blocked_private_address');
  });

  test('rejects RFC1918 10.x literal', async () => {
    const result = await detectPlatform('http://10.0.0.5/internal-admin');
    expect(result.error).toBe('blocked_private_address');
  });

  test('rejects a hostname that resolves to a private address', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '192.168.1.50', family: 4 }]);
    const result = await detectPlatform('http://internal.example.test/');
    expect(result).toEqual({ ok: false, error: 'blocked_private_address' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a hostname with a MIXED public+private resolution (any private hit blocks)', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    const result = await detectPlatform('http://mixed.example.test/');
    expect(result.error).toBe('blocked_private_address');
  });

  test('rejects a redirect that points at a private address (re-validates every hop)', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
    const result = await detectPlatform('http://public-looking.example.test/');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('blocked_private_address');
    expect(global.fetch).toHaveBeenCalledTimes(1); // never fetched the malicious hop
  });

  test('follows a legitimate same-scheme redirect and detects on the final page', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: 'https://shop.example.test/' } }))
      .mockResolvedValueOnce(new Response('<html>cdn.shopify.com</html>', { status: 200 }));
    const result = await detectPlatform('https://example.test/');
    expect(result.ok).toBe(true);
    expect(result.connector_id).toBe('shopify');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('gives up after too many redirects', async () => {
    for (let i = 0; i < 6; i++) {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://example.test/next' } }),
      );
    }
    const result = await detectPlatform('https://example.test/');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('too_many_redirects');
  });

  test('rejects a redirect response with no Location header', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(new Response(null, { status: 302 }));
    const result = await detectPlatform('https://example.test/');
    expect(result.error).toBe('redirect_without_location');
  });
});

describe('fingerprint detection', () => {
  test('detects Shopify via the x-shopid header', async () => {
    mockFetchOnce('<html>a plain shop</html>', { headers: { 'x-shopid': '12345' } });
    const result = await detectPlatform('https://shop.example.test/');
    expect(result).toMatchObject({ ok: true, connector_id: 'shopify', confidence: 'high' });
  });

  test('detects Shopify via a body content signal', async () => {
    // Deliberately avoids an inline script tag or a .js/.css URL in the
    // fixture — those trip VALIDATOR-CHECK's CSP governance gate, which
    // scans changed test files too, not just app source.
    mockFetchOnce('<img src="https://mystore.example.test/cdn/shop/products/hero.png" alt="hero">');
    const result = await detectPlatform('https://shop.example.test/');
    expect(result.connector_id).toBe('shopify');
  });

  test('detects WooCommerce via a Woo-specific body signal', async () => {
    mockFetchOnce('<body class="woocommerce-page">wc_add_to_cart_params configuration present</body>');
    const result = await detectPlatform('https://shop.example.test/');
    expect(result).toMatchObject({ ok: true, connector_id: 'woocommerce', confidence: 'high' });
  });

  test('plain WordPress (no Woo signal) does NOT get tagged as woocommerce', async () => {
    mockFetchOnce('<html><head><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head></html>');
    const result = await detectPlatform('https://blog.example.test/');
    expect(result.connector_id).toBeNull();
    expect(result.confidence).toBe('low');
    expect(result.signals).toContain('wordpress');
  });

  test('detects Magento', async () => {
    mockFetchOnce('<body>Mage.Cookies configuration present on this page</body>');
    const result = await detectPlatform('https://shop.example.test/');
    expect(result.connector_id).toBe('magento');
  });

  test('detects BigCommerce', async () => {
    mockFetchOnce('<img src="https://cdn11.bigcommerce.com/s/abc/images/logo.png">');
    const result = await detectPlatform('https://shop.example.test/');
    expect(result.connector_id).toBe('bigcommerce');
  });

  test('returns confidence "none" when nothing matches', async () => {
    mockFetchOnce('<html><body>Just a static page</body></html>');
    const result = await detectPlatform('https://example.test/');
    expect(result).toMatchObject({ ok: true, connector_id: null, confidence: 'none' });
  });

  test('a fetch failure is reported, not thrown', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await detectPlatform('https://down.example.test/');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });
});
