# Multi-Tenancy

> VITANA supports multiple tenant portals (Maxina, Alkalma, Earthlinks, Exafy) with tenant-specific screen availability, portal branding, and a TenantProvider architecture that controls which features are accessible in each portal.

## Tenant Types

| Tenant | Description | Total Screens |
|--------|-------------|---------------|
| **Global** | Base screens accessible across all tenant portals | 304 |
| **Maxina** | Premium portal with full feature access | 307 |
| **Alkalma** | Portal with restricted Sell & Earn features | 306 |
| **Earthlinks** | Portal with restricted Sell & Earn and Analytics | 305 |
| **Exafy** | Internal admin portal with full access plus admin tools | 311 |

## Tenant Screen Availability

### Global Screens (304)
Available to all tenants. Includes:
- All Public/Auth screens (Landing, Generic Auth, Community Portal Login, 404)
- All Home, Community, Discover, Health, Inbox, AI, Wallet, Sharing, Memory, and Settings screens
- All Utility screens (Calendar, Search, Profile, Notifications)
- All Global Overlays
- Business Hub screens (BIZ-001 to BIZ-005, subject to tenant restrictions)

### Maxina Portal
- All 304 Global screens
- 3 Maxina-specific screens (Maxina Portal Login, Email Confirmation, branded auth)
- Full Business Hub access (all 5 BIZ screens)
- Premium glassmorphic auth with video background
- **Total: 307 screens**

### Alkalma Portal
- All 304 Global screens
- 2 Alkalma-specific screens
- Business Hub with **BIZ-004 (Sell & Earn) restricted**
- **Total: 306 screens**

### Earthlinks Portal
- All 304 Global screens
- 2 Earthlinks-specific screens
- Business Hub with **BIZ-004 (Sell & Earn) and BIZ-005 (Analytics) restricted**
- **Total: 305 screens**

### Exafy Portal (Internal)
- All 304 Global screens
- Exafy Admin Portal Login (AUTH-007)
- All Admin and Dev Hub screens
- Full Business Hub access
- **Total: 311 screens**

## Business Hub Restrictions by Tenant

| BIZ Screen | Maxina | Alkalma | Earthlinks | Exafy |
|------------|--------|---------|------------|-------|
| BIZ-001: Overview | Yes | Yes | Yes | Yes |
| BIZ-002: Services | Yes | Yes | Yes | Yes |
| BIZ-003: Clients | Yes | Yes | Yes | Yes |
| BIZ-004: Sell & Earn | Yes | **No** | **No** | Yes |
| BIZ-005: Analytics | Yes | Yes | **No** | Yes |

## Portal Branding

Each tenant portal has its own branded authentication experience:
- **Maxina (AUTH-003)**: Premium glassmorphic auth with video background at `/maxina`
- **Alkalma (AUTH-004)**: Branded portal at `/alkalma` (needs visual upgrade)
- **Earthlinks (AUTH-005)**: Branded portal at `/earthlinks` (needs visual upgrade)
- **Community (AUTH-006)**: Community portal at `/community` (needs visual upgrade)
- **Exafy (AUTH-007)**: Internal admin portal (needs visual upgrade)

## TenantProvider Architecture

The TenantProvider wraps the application and controls:
- Which screens/features are available per tenant
- Portal-specific branding and theming
- Tenant-specific configuration in Dev Settings (`/dev/settings/tenants`)
- Four registered tenants: System, Maxina, Earthlinks, AlKalma

Tenant configuration is managed via the Dev Hub at `/dev/settings/tenants` with tabs for Tenant List, Tenant Users, and Tenant Configs.

## Role-Tenant Interaction

Screens require both the correct role AND tenant availability. For example:
- A Community user on Alkalma can access 286 role screens, minus any Alkalma-restricted screens
- An Admin on Exafy has access to all 551 screens
- Patient/Professional/Staff screens are Global (available on all tenants)

## Related Pages

- [[role-based-access]] -- Role-based screen access matrix
- [[screen-registry]] -- Full screen registry with tenant codes
- [[business-hub]] -- Business Hub with tenant-specific restrictions
- [[apple-compliance]] -- iOS-specific feature gating (isIAPRestricted)

## Sources

- `raw/screen-registry/TENANT_SCREEN_AVAILABILITY.md`
- `raw/screen-registry/SCREEN_REGISTRY.md`
- `raw/design-system/emoji-icon-mapping.md`

## Last Updated

2026-04-12
