# Vitanaland Token (VTNA) Design

**Date:** 2026-06-30
**Status:** Approved (written-spec review complete — see §11 Implementation Notes)

## 1. Objective

Build and validate a Base ERC-20 named **Vitanaland Token** with symbol **VTNA**. It must be importable and transferable in MetaMask, support holder burns and ERC-2612 permits, and offer capped ERC-3156 flash minting with a treasury fee.

The release sequence is local testing, Base Sepolia rehearsal, and then a Base mainnet technical launch after an explicit user checkpoint. The mainnet milestone does **not** include a public sale, public distribution, a liquidity pool, redemption, or financial promotion.

## 2. Scope

### In scope

- A non-upgradeable ERC-20 contract built from OpenZeppelin Contracts.
- One-time issuance of 100 billion VTNA to a treasury address.
- Standard transfers, approvals, `transferFrom`, holder burns, allowance-based burns, and ERC-2612 permit.
- ERC-3156 flash minting with an adjustable cap and fee.
- A fixed flash-fee recipient.
- Two-step ownership for the two adjustable flash parameters.
- Local unit, fuzz, and invariant tests.
- Deployment scripts and verification for Base Sepolia and Base mainnet.
- MetaMask import and transfer validation.
- Operational documentation that never stores a seed phrase or raw private key.

### Out of scope

- Public token sale, airdrop, exchange listing, or DEX liquidity.
- A frontend or token website.
- Upgradeable proxies.
- Administrative permanent minting, seizure, blacklisting, or transfer pausing.
- On-chain reserve custody, price oracles, portfolio rebalancing, redemption, or a legal claim on reserve assets.
- Marketing VTNA as redeemable, guaranteed, or asset-backed.

Any later crypto-treasury disclosure program is a separate project. Under this design, VTNA holders have **no** contractual or on-chain right to withdraw treasury assets.

## 3. Fixed token parameters

| Parameter | Value |
|-----------|-------|
| Name | Vitanaland Token |
| Symbol | VTNA |
| Decimals | 18 |
| Initial persistent supply | 100,000,000,000 VTNA |
| Initial flash cap | 10,000,000,000 VTNA |
| Maximum flash cap | 10,000,000,000 VTNA |
| Initial flash fee | 5 basis points (0.05%) |
| Maximum flash fee | 100 basis points (1%) |
| Basis-point denominator | 10,000 |

The constructor takes one nonzero treasury address. It mints the entire initial supply to that address, makes it the initial owner, and stores it as the immutable flash-fee recipient. The deployer receives no continuing authority.

The contract exposes no external permanent-mint function. Flash minting temporarily increases `totalSupply()` during one transaction; successful repayment burns the borrowed principal before that transaction completes. Because the flash fee is transferred to the treasury rather than burned, a successful flash loan returns persistent supply to its pre-loan value.

## 4. Contract architecture

The contract composes these OpenZeppelin Contracts v5.6.1 components:

- `ERC20` for balances, transfers, approvals, and 18-decimal metadata.
- `ERC20Burnable` for `burn` and `burnFrom`.
- `ERC20Permit` for EIP-2612 signed approvals.
- `ERC20FlashMint` for ERC-3156 flash loans.
- `Ownable2Step` for safer transfer of the limited parameter-setting authority.

The implementation uses Solidity 0.8.35 and a stable Foundry v1.7.1 toolchain. Exact dependency commits and compiler settings are committed with the project so Sepolia and mainnet builds are reproducible.

### Adjustable state

Only two values are owner-adjustable:

- `flashCap`, constrained to `0 <= flashCap <= 10_000_000_000 ether`.
- `flashFeeBps`, constrained to `0 <= flashFeeBps <= 100`.

The initial values are 10 billion VTNA and 5 basis points. A zero cap disables flash loans; a zero fee makes them fee-free. Updates take effect immediately and emit events containing the previous and new values.

**Suggested public interface:**

- `setFlashCap(uint256 newCap)`
- `setFlashFeeBps(uint256 newFeeBps)`
- `flashCap()`
- `flashFeeBps()`
- `treasury()`

**Suggested events:**

- `FlashCapUpdated(uint256 previousCap, uint256 newCap)`
- `FlashFeeBpsUpdated(uint256 previousFeeBps, uint256 newFeeBps)`

**Suggested custom errors:**

- `ZeroTreasury()`
- `FlashCapExceedsMaximum(uint256 requested, uint256 maximum)`
- `FlashFeeExceedsMaximum(uint256 requested, uint256 maximum)`
- `OwnershipRenunciationDisabled()`

### Flash-loan behavior

- `maxFlashLoan(address token)` returns the configured cap for VTNA and zero for any other token.
- The fee is `floor(amount * flashFeeBps / 10_000)`, using full-precision multiplication and division.
- Very small loans may round down to a zero fee; this is accepted behavior.
- The fee receiver is always the original treasury address and cannot be changed.
- The borrower must implement the ERC-3156 callback, return the required selector, hold principal plus fee at repayment, and approve the token contract to collect them.
- Requests above the cap, requests for unsupported tokens, invalid callbacks, insufficient balances, and insufficient repayment approvals revert atomically.

### Ownership behavior

The owner's only privileged abilities are calling the two flash-parameter setters and using the standard ownership-transfer functions. Ownership transfer requires the nominated owner to accept. `renounceOwnership` is disabled so parameter control cannot be destroyed accidentally. Transferring ownership does not change the original treasury or fee recipient.

## 5. Wallet and operational security

- Use a dedicated MetaMask treasury account rather than an everyday wallet.
- Store its seed phrase offline. Never paste it into chat, source files, environment files, commands, screenshots, or support forms.
- Use a separate Foundry deployer account held in Foundry's encrypted keystore. The deployer only pays gas.
- Deployment receives the treasury's public address as a constructor argument; it never needs the treasury private key.
- Do not use a `PRIVATE_KEY` environment variable.
- Review the treasury address on-screen and with a second independent check before every deployment.

An ordinary MetaMask account is a single point of failure. This is an accepted project decision for the technical launch, not an endorsement for later public or high-value operations.

## 6. Testing strategy

### Unit tests

- Correct name, symbol, decimals, treasury, owner, initial supply, cap, fee, and fee recipient.
- Constructor rejection of the zero treasury address.
- Transfers, approvals, `transferFrom`, `burn`, and `burnFrom`.
- Valid permit, expired permit, invalid signer, nonce increment, and replay rejection.
- Successful flash loan and callback.
- Exact treasury fee delivery and restoration of pre-loan persistent supply.
- Loans at the cap, above the cap, and after setting the cap to zero.
- Fee calculations at zero, initial, and maximum fee values, including rounding boundaries.
- Unsupported loan token, invalid callback selector, insufficient repayment balance, and insufficient approval.
- Authorized cap and fee changes, expected events, and all hard limits.
- Unauthorized updates.
- Two-step ownership transfer and disabled renunciation.
- Absence of any callable persistent-mint, pause, seizure, or blacklist path.

### Fuzz and invariant tests

- Fuzz transfers, burns, flash amounts, fee settings, and cap settings across allowed ranges.
- Prove no successful setter call can exceed a hard ceiling.
- Prove successful flash loans restore supply and deliver exactly the quoted fee.
- Prove failed flash loans leave balances, supply, and configuration unchanged.
- Prove persistent supply can only stay constant or decrease through holder burns (asserted as a per-transaction post-condition; flash mint transiently raises `totalSupply` mid-transaction).

### Quality gates

- `forge fmt --check`
- clean optimized build with the pinned Solidity compiler
- full unit and fuzz suite
- invariant suite
- coverage review, including every privileged and failure path
- static analysis with no unresolved high- or medium-severity finding
- secret scan and clean Git status

## 7. Deployment and verification

### Base Sepolia rehearsal

1. Install the pinned stable Foundry toolchain.
2. Import a funded testnet deployer with `cast wallet import ... --interactive`.
3. Compile and run every quality gate.
4. Deploy to Base Sepolia (chain ID 84532) using the encrypted account.
5. Verify the exact source and constructor argument on the explorer.
6. Query metadata, supply, treasury, owner, cap, and fee independently with `cast`.
7. Import the verified address into MetaMask on Base Sepolia.
8. Test a small transfer, approval, `transferFrom`, and holder burn.
9. Test a flash loan and confirm the treasury fee and supply restoration.
10. Change the cap and fee within their limits, confirm events, then restore the initial values.
11. Record the contract address, deployment transaction, source commit, dependency versions, compiler settings, and test output.

### Base mainnet gate

Mainnet deployment is not automatic. It requires:

- every Sepolia gate passing against the final source commit;
- the mainnet treasury address confirmed twice;
- sufficient Base ETH for gas in the encrypted deployer account;
- an explicit user approval immediately before broadcast;
- the same constructor values and build configuration used in the final rehearsal.

After deployment to Base mainnet (chain ID 8453), verify the source, independently query configuration, import VTNA into MetaMask, and perform one small transfer test. Publish no public sale, liquidity, redemption, or reserve claim as part of this milestone.

## 8. Failure handling

The contract is deliberately non-upgradeable. A source or configuration error discovered after mainnet deployment cannot be patched at that address. The response is to stop using the affected address, document the problem, correct and retest the source, deploy a new contract, and clearly identify which address is canonical. This makes the pre-broadcast checkpoint and exact explorer verification mandatory.

## 9. Success criteria

The technical launch is complete only when:

- the exact source passes all local gates;
- the Sepolia rehearsal passes end to end;
- the mainnet source is verified;
- MetaMask displays Vitanaland Token / VTNA with 18 decimals;
- normal transfers and holder burns succeed;
- the initial owner can change cap and fee only within their immutable ceilings;
- flash loans cannot exceed 10 billion VTNA;
- the initial 0.05% fee reaches the fixed treasury;
- no persistent administrative minting path exists; and
- the deployment records contain no secret material.

## 10. References

- Base: Deploy Smart Contracts
- Base network configuration
- OpenZeppelin Contracts ERC-20 API
- OpenZeppelin Contracts access control
- MetaMask: Display custom tokens

## 11. Implementation Notes (added during written-spec review, 2026-06-30)

These notes resolve ambiguities found during review. They refine *how* the
design in §1–§10 is implemented; they do not change its intent. Toolchain pins
in §4 were verified to exist and are each the current latest stable:
OpenZeppelin Contracts `5.6.1`, Solidity `0.8.35`, Foundry `v1.7.1`.

### 11.1 Required overrides (the entire custom surface)

The custom behavior is implemented through exactly four overrides over the OZ
base contracts. The implementer must provide all four — the rest is inherited.

1. **`_flashFeeReceiver()` → returns the immutable `treasury`.**
   This is load-bearing. OpenZeppelin's default `_flashFeeReceiver()` returns
   `address(0)`, which causes the fee to be **burned** rather than transferred.
   The §3 guarantee that "the flash fee is transferred to the treasury rather
   than burned, [so] a successful flash loan returns persistent supply to its
   pre-loan value" is only true because this override returns a non-zero
   recipient. With a non-zero receiver, `flashLoan` mints `amount`, burns
   `amount`, and transfers `fee` from the borrower to the treasury — net
   persistent-supply change of zero.
2. **`_flashFee(address token, uint256 amount)` → `floor(amount * flashFeeBps / 10_000)`**
   for the supported token (VTNA).
3. **`maxFlashLoan(address token)` → `flashCap` for VTNA, `0` otherwise.**
   Note this intentionally replaces OZ's default `type(uint256).max -
   totalSupply()` headroom guard. That is safe here: max cap (10B) plus the
   fixed initial supply (100B) at 18 decimals is ~1.1e29, far below `uint256`
   max (~1.15e77), so `totalSupply + amount` cannot overflow.
4. **`renounceOwnership()` → revert with `OwnershipRenunciationDisabled()`.**

### 11.2 Setter authorization

`setFlashCap` and `setFlashFeeBps` are `onlyOwner`. The "unauthorized updates"
test in §6 asserts that any non-owner caller reverts with OZ's
`OwnableUnauthorizedAccount`.

### 11.3 Custom errors vs OpenZeppelin's built-ins

The four custom errors in §4 cover conditions OZ does not: zero treasury at
construction, the **setter** ceilings for cap/fee, and disabled renunciation.
Do not redefine errors OZ already provides — reuse them where they already
apply:

- Borrow above the cap / unsupported token → OZ's `ERC3156ExceededMaxLoan` /
  `ERC3156UnsupportedToken` (raised by the inherited `flashLoan`/`flashFee`).
- Unauthorized owner-only call → OZ's `OwnableUnauthorizedAccount`.
- Permit failures → OZ's ERC-2612 errors.

`FlashCapExceedsMaximum` / `FlashFeeExceedsMaximum` are reserved strictly for
the setter ceilings (`> 10_000_000_000 ether` and `> 100` respectively), not
the borrow path.

### 11.4 Build reproducibility — pin the EVM target

`foundry.toml` must pin `evm_version` explicitly (not rely on the compiler
default) and pin optimizer settings (`optimizer = true`, fixed `runs`). The
chosen `evm_version` must be one supported by Base mainnet and Base Sepolia at
deploy time, so the compiled bytecode contains no opcodes the target chain's
deployed fork does not support. A quality gate must assert that the Sepolia
rehearsal build and the mainnet build use an identical `evm_version`, optimizer
configuration, and compiler version, so the §7 "same build configuration"
requirement is mechanically enforced rather than manual.
