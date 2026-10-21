/**
 * VTID-03894 — a product must ship somewhere, on PATCH as well as on POST.
 *
 * Discover gates every row on `ships_to_countries.includes(country)` OR
 * `ships_to_regions.includes(region)` (routes/discover-feed.ts). A product
 * naming neither can never be shown to anyone: it sits in the supplier's
 * portal looking listed, is approved by an admin, and reaches nobody.
 *
 * POST enforces this through a zod refine. PATCH could not: `.refine()`
 * returns a ZodEffects and ZodEffects has no `.partial()`, so the patch body
 * is built from the plain object and the refine does not come with it.
 *
 * The hole that opened was not merely "the check is missing on PATCH" — it is
 * that the check is NOT DECIDABLE from a patch alone. Clearing
 * ships_to_countries is perfectly valid when the row already ships to a
 * region, and emptying both is not, and a fragment cannot tell those apart.
 * So the handler merges the patch over the stored row and checks that, and
 * this pins the predicate that decision rests on.
 */
import { shipsSomewhere } from '../../src/routes/vcaop-portal-my-products';

describe('a product must ship somewhere', () => {
  it('accepts a country list', () => {
    expect(shipsSomewhere({ ships_to_countries: ['DE'] })).toBe(true);
  });

  it('accepts a region list', () => {
    expect(shipsSomewhere({ ships_to_regions: ['EU'] })).toBe(true);
  });

  it('rejects both empty — the row Discover can never show', () => {
    expect(shipsSomewhere({ ships_to_countries: [], ships_to_regions: [] })).toBe(false);
  });

  it('rejects both absent', () => {
    expect(shipsSomewhere({})).toBe(false);
  });

  it('rejects one empty and the other absent', () => {
    // The shape a careless PATCH produces: clear the countries, say nothing
    // about regions, and the product silently stops being showable.
    expect(shipsSomewhere({ ships_to_countries: [] })).toBe(false);
    expect(shipsSomewhere({ ships_to_regions: [] })).toBe(false);
  });

  describe('merged against the stored row, which is what the handler checks', () => {
    it('lets a patch clear countries when the row already ships to a region', () => {
      const stored = { ships_to_countries: ['DE'], ships_to_regions: ['EU'] };
      const patch = { ships_to_countries: [] };
      expect(shipsSomewhere({ ...stored, ...patch })).toBe(true);
    });

    it('refuses a patch that empties the row\'s only destination', () => {
      const stored = { ships_to_countries: ['DE'], ships_to_regions: [] };
      const patch = { ships_to_countries: [] };
      expect(shipsSomewhere({ ...stored, ...patch })).toBe(false);
    });

    it('lets a patch move a row from countries to regions in one step', () => {
      const stored = { ships_to_countries: ['DE'], ships_to_regions: [] };
      const patch = { ships_to_countries: [], ships_to_regions: ['EU'] };
      expect(shipsSomewhere({ ...stored, ...patch })).toBe(true);
    });

    it('is not fooled by a patch that omits the field entirely', () => {
      // `undefined` from a spread must not overwrite the stored value —
      // if it did, any patch would read as "ships nowhere".
      const stored = { ships_to_countries: ['DE'] };
      const patch: { ships_to_regions?: string[] } = {};
      expect(shipsSomewhere({ ...stored, ...patch })).toBe(true);
    });
  });
});
