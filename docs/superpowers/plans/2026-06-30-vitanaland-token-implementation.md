# Vitanaland Token (VTNA) — Implementation Plan

**Status**: Ready to execute. Phases are dependency-ordered; do not skip the gates.
**Owner**: Claude (assisted) + user checkpoints at the two STOP-AND-ASK gates.
**Date**: 2026-06-30.
**Implements**: `docs/superpowers/specs/2026-06-30-vitanaland-token-design.md` (approved). The spec is the source of truth for *what*; this plan is *how* and *in what order*. Where they ever disagree, the spec wins — fix this plan.

This plan turns the approved VTNA design into a built, tested, and deployed Base ERC-20. It is deliberately staged so that nothing irreversible (a mainnet broadcast) happens without a passing rehearsal and an explicit user "go".

---

## 0. Ground rules carried from the spec

- **Non-upgradeable.** A bug found after mainnet is fixed by deploying a *new* contract, not patching. That makes the rehearsal and the pre-broadcast checkpoint mandatory, not optional.
- **No secrets in the repo.** No seed phrase, no raw private key, no `PRIVATE_KEY` env var, ever — in source, env files, commit messages, or logs. Deployer uses Foundry's encrypted keystore; the treasury contributes only its *public* address.
- **Pinned, verified toolchain** (confirmed current latest stable during review): OpenZeppelin Contracts `5.6.1`, Solidity `0.8.35`, Foundry `v1.7.1`. Pin them exactly so Sepolia and mainnet builds are byte-for-byte reproducible.
- **This is a self-contained sub-project.** The repo has no existing Solidity. Everything below lives under a new, isolated `contracts/vitanaland-token/` tree and does not touch the TypeScript services.

---

## 1. Target file layout

```
contracts/vitanaland-token/
  foundry.toml                     # pinned solc, evm_version, optimizer, fuzz/invariant runs
  remappings.txt                   # @openzeppelin/contracts -> lib/openzeppelin-contracts
  .gitignore                       # ignore out/, cache/, broadcast/, .env*
  .env.example                     # NON-SECRET names only: RPC URLs, explorer keys, treasury ADDRESS
  lib/
    openzeppelin-contracts/        # submodule pinned to v5.6.1 tag
    forge-std/                     # submodule pinned to a v1.7.x-compatible tag
  src/
    VitanalandToken.sol            # the contract
  test/
    VitanalandToken.t.sol          # unit tests
    VitanalandTokenFuzz.t.sol      # fuzz tests
    VitanalandTokenInvariant.t.sol # invariant tests + handler
    mocks/
      FlashBorrower.sol            # compliant ERC-3156 borrower
      BadFlashBorrower.sol         # wrong selector / under-repay / no-approve variants
  script/
    Deploy.s.sol                   # constructor-arg = treasury public address
  README.md                        # operational runbook (no secrets)
```

---

## 2. Phases

### Phase P0 — Scaffold + reproducible toolchain (no contract logic yet)

**Goal:** an empty-but-buildable Foundry project that compiles with the exact pinned toolchain and runs in CI.

1. `forge init` the project under `contracts/vitanaland-token/` (no template).
2. Add OZ as a submodule pinned to the **`v5.6.1` tag**; add `forge-std` pinned to a tag compatible with Foundry v1.7.1. Write `remappings.txt`.
3. Author `foundry.toml` with everything pinned (see §3 for the exact knobs that matter): `solc = "0.8.35"`, explicit `evm_version`, `optimizer = true` + fixed `runs`, and fuzz/invariant run counts.
4. `.gitignore` for `out/ cache/ broadcast/ .env*`. Commit `.env.example` with **non-secret** keys only.
5. Add a CI workflow (kebab-case-named per repo convention, e.g. `CONTRACTS-VTNA-CI.yml`) that runs `forge fmt --check`, `forge build`, `forge test`, on PRs touching `contracts/vitanaland-token/**`.

**Exit criteria:** `forge build` succeeds with solc 0.8.35; CI is green on an empty contract.

---

### Phase P1 — Implement `VitanalandToken.sol`

**Goal:** the contract exactly as specified, with the four required overlays from spec §11 and nothing more.

Compose `ERC20`, `ERC20Burnable`, `ERC20Permit`, `ERC20FlashMint`, `Ownable2Step`.

**Constructor** `(address treasury)`:
- Revert `ZeroTreasury()` if `treasury == address(0)`.
- `ERC20("Vitanaland Token", "VTNA")`, `ERC20Permit("Vitanaland Token")`, `Ownable(treasury)`.
- `_mint(treasury, 100_000_000_000 ether)` (1e29 wei → 100B at 18 decimals).
- Store `treasury` in an `immutable` (`_treasury`); initialize `flashCap = 10_000_000_000 ether`, `flashFeeBps = 5`.

**Constants:**
- `MAX_FLASH_CAP = 10_000_000_000 ether`
- `MAX_FLASH_FEE_BPS = 100`
- `BPS_DENOMINATOR = 10_000`

**The four required overrides (the entire custom surface — spec §11.1):**
1. `_flashFeeReceiver()` → returns `_treasury`. **Load-bearing:** OZ's default returns `address(0)`, which *burns* the fee instead of sending it to treasury; without this override the "fee to treasury / supply restored" guarantee is false.
2. `_flashFee(address token, uint256 amount)` → `amount * flashFeeBps / BPS_DENOMINATOR` (floor; full-precision). (`token` is already validated as VTNA by OZ's public `flashFee`.)
3. `maxFlashLoan(address token)` → `token == address(this) ? flashCap : 0`. Intentionally replaces OZ's `type(uint256).max - totalSupply()` headroom guard; safe because `100B + 10B` at 18 decimals ≪ `uint256` max.
4. `renounceOwnership()` → `revert OwnershipRenunciationDisabled()`.

**Setters (both `onlyOwner` — spec §11.2):**
- `setFlashCap(uint256 newCap)`: revert `FlashCapExceedsMaximum(newCap, MAX_FLASH_CAP)` if `newCap > MAX_FLASH_CAP`; else store and `emit FlashCapUpdated(old, newCap)`.
- `setFlashFeeBps(uint256 newFeeBps)`: revert `FlashFeeExceedsMaximum(newFeeBps, MAX_FLASH_FEE_BPS)` if `newFeeBps > MAX_FLASH_FEE_BPS`; else store and `emit FlashFeeBpsUpdated(old, newFeeBps)`.

**Views:** `flashCap()`, `flashFeeBps()`, `treasury()` (return the immutable).

**Errors (spec §11.3 — do NOT redefine OZ's):** define only `ZeroTreasury`, `FlashCapExceedsMaximum`, `FlashFeeExceedsMaximum`, `OwnershipRenunciationDisabled`. Let OZ raise `OwnableUnauthorizedAccount`, `ERC3156ExceededMaxLoan`, `ERC3156UnsupportedToken`, and the ERC-2612 errors for their own conditions.

**Exit criteria:** compiles clean; `forge fmt --check` passes; no compiler warnings.

---

### Phase P2 — Unit tests (`VitanalandToken.t.sol`)

Map 1:1 to spec §6 "Unit tests". Each bullet is at least one test:
- Metadata & init: name, symbol, `decimals()==18`, treasury, owner, `totalSupply()==1e29`, `flashCap`, `flashFeeBps`, fee recipient.
- Constructor rejects zero treasury (`ZeroTreasury`).
- ERC-20 core: transfer, approve, `transferFrom`, `burn`, `burnFrom`.
- Permit: valid permit; expired deadline; wrong signer; nonce increments; replay rejected.
- Flash loan happy path via `FlashBorrower`: callback returns the magic selector; treasury receives exactly `floor(amount*bps/1e4)`; `totalSupply` returns to pre-loan value.
- Cap behavior: loan at cap succeeds; above cap reverts (`ERC3156ExceededMaxLoan`); after `setFlashCap(0)` all flash loans revert.
- Fee math at `bps = 0` (zero fee), `5` (initial), `100` (max); rounding boundary (tiny amount → zero fee accepted).
- Failure paths via `BadFlashBorrower`: unsupported token; wrong selector; insufficient repayment balance; insufficient approval — all revert atomically (state unchanged).
- Authorization: `setFlashCap`/`setFlashFeeBps` succeed for owner, emit the right events, enforce hard limits; revert `OwnableUnauthorizedAccount` for non-owner.
- Ownership: full two-step transfer (propose → accept); `renounceOwnership()` reverts `OwnershipRenunciationDisabled`; treasury/fee-recipient unchanged after an ownership transfer.
- Negative-surface assertions: there is no callable permanent-mint, pause, seizure, or blacklist path.

**Exit criteria:** all unit tests pass.

---

### Phase P3 — Fuzz + invariant tests

`VitanalandTokenFuzz.t.sol`:
- Fuzz transfers, burns, flash amounts, and setter values across allowed ranges.

`VitanalandTokenInvariant.t.sol` (+ a handler that bounds actor actions):
- No successful setter call can exceed `MAX_FLASH_CAP` / `MAX_FLASH_FEE_BPS`.
- Every successful flash loan restores `totalSupply` and delivers exactly the quoted fee.
- Every failed flash loan leaves balances, supply, and config unchanged.
- **Per-transaction post-condition:** persistent supply only stays constant or decreases (via holder burns) — assert at transaction boundaries, since flash mint transiently raises `totalSupply` mid-call.

**Exit criteria:** fuzz + invariant suites pass at the configured run counts.

---

### Phase P4 — Quality gates (all must pass before any deploy)

Run the full spec §6 gate set and wire them into CI:
- `forge fmt --check`
- clean optimized build with pinned solc 0.8.35
- full unit + fuzz suite
- invariant suite
- `forge coverage` review — every privileged path and every revert path exercised
- static analysis (**Slither**) — zero unresolved high/medium findings (triage & document any acknowledged low)
- secret scan + clean `git status`
- **build-config parity check** (spec §11.4): assert the build uses the pinned `evm_version`, optimizer config, and solc version — the same config the rehearsal and mainnet will use.

**Exit criteria:** every gate green in CI on the final source commit.

---

### Phase P5 — Base Sepolia rehearsal (chain 84532)

Per spec §7. Uses the **encrypted keystore deployer**; treasury private key never touches this.
1. Install pinned Foundry v1.7.1.
2. `cast wallet import vtna-deployer --interactive` (funded Sepolia deployer).
3. Run every P4 gate against the final source commit.
4. `forge script script/Deploy.s.sol --rpc-url base_sepolia --account vtna-deployer --broadcast` with the treasury **public** address as the constructor arg.
5. Verify exact source + constructor arg on the Base Sepolia explorer.
6. Independently read back metadata/supply/treasury/owner/cap/fee with `cast call`.
7. Import the verified address into MetaMask (Base Sepolia); confirm "Vitanaland Token / VTNA / 18".
8. Exercise live: small transfer, approve, `transferFrom`, holder burn.
9. Run a real flash loan; confirm treasury fee landed and supply restored.
10. Change cap & fee within limits, confirm events, restore initials.
11. Record: address, deploy tx, source commit, dependency versions, compiler settings, test output → into the project README/records.

**Exit criteria:** end-to-end rehearsal passes and is recorded.

### 🛑 STOP-AND-ASK GATE 1 — "Sepolia is green, proceed to mainnet prep?"
Do not touch mainnet until the user reviews the rehearsal record and says go.

---

### Phase P6 — Base mainnet (chain 8453) — gated, irreversible

Per spec §7 "Base mainnet gate". Preconditions, all required:
- every Sepolia gate passing **against the final source commit**;
- the mainnet **treasury address confirmed twice** (on-screen + a second independent check);
- enough Base ETH for gas in the encrypted deployer;
- identical constructor values + build configuration as the final rehearsal.

### 🛑 STOP-AND-ASK GATE 2 — explicit user approval *immediately before broadcast*
This is the point of no return. Only after an explicit "go" this turn:
1. Broadcast `Deploy.s.sol` to Base mainnet with the confirmed treasury address.
2. Verify exact source + constructor arg on the explorer.
3. Independently read back full configuration with `cast`.
4. Import VTNA into MetaMask (Base mainnet); confirm name/symbol/decimals.
5. One small transfer test.
6. Publish **no** sale/liquidity/redemption/reserve claim — this milestone is technical only.

**Exit criteria:** mainnet source verified; spec §9 success criteria all met.

---

### Phase P7 — Records & handoff

- Finalize the project README runbook (addresses, tx hashes, commit, toolchain, verification links) — **no secret material**.
- Note clearly which address is canonical (matters because of non-upgradeability / spec §8).
- Update this plan's execution log (below) as phases complete.

---

## 3. The `foundry.toml` knobs that actually matter (spec §11.4)

Reproducibility and Base-compatibility hinge on these being explicit, not defaulted:
- `solc_version = "0.8.35"` — pinned, not a range.
- `evm_version` — set explicitly to a target **Base mainnet and Base Sepolia both support at deploy time** (verify against Base's current supported fork before P5; do not let solc pick a newer default that emits opcodes Base hasn't enabled).
- `optimizer = true`, `optimizer_runs = <fixed N>` — pinned.
- `fuzz.runs` / `invariant.runs` + `invariant.depth` — pinned so CI is deterministic in effort.
- A CI assertion that the rehearsal and mainnet builds use identical `solc_version` + `evm_version` + optimizer config.

---

## 4. Sequencing summary

```
P0 scaffold ─▶ P1 contract ─▶ P2 unit ─▶ P3 fuzz/invariant ─▶ P4 gates
                                                                 │
                                                                 ▼
                                                    P5 Sepolia rehearsal
                                                                 │
                                                        🛑 GATE 1 (user)
                                                                 ▼
                                                    P6 mainnet preconditions
                                                                 │
                                                   🛑 GATE 2 (user, pre-broadcast)
                                                                 ▼
                                                     deploy ─▶ verify ─▶ P7 records
```

P0→P4 are safe to run straight through (nothing leaves the local machine / CI). The two gates bracket the only irreversible action.

---

## 5. Open items to confirm before P5 (cheap to resolve, listed so they don't surprise us)

1. **Project location** — this plan puts the Foundry project at `contracts/vitanaland-token/`. Confirm that's where you want it (vs. a separate repo). Easy to change before P0.
2. **`evm_version` value** — pick the exact target after checking Base's currently-supported fork at build time (P3 §11.4 leaves this as a verified-at-build step, not a guess).
3. **Funding** — a funded Sepolia deployer (P5) and a funded mainnet deployer + confirmed mainnet treasury address (P6) are user-supplied; deployment can't proceed without them.

None of these block starting P0.

---

## 6. Execution log

_(append as phases complete)_

- 2026-06-30 — Plan written from approved spec. Awaiting go to start P0.
