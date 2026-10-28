# D1 Compliance Fields Template

This template defines the standard D1 compliance fields to be added to every screen entry in SCREEN_REGISTRY.md

## Required Fields (in order):

1. **Purpose** — Brief description of what the screen is for and its primary function
2. **Primary APIs Used** — Main API endpoints consumed (e.g., Supabase Auth, Stripe API, custom endpoints)
3. **DB Tables / Models Used** — Key data sources and database tables accessed
4. **Compliance Notes** — Medical/privacy/billing/safety/age restriction requirements
5. **Event Triggers** — Analytics events, logs, autopilot triggers dispatched from this screen
6. **Dependencies** — Critical components, hooks, contexts, or screens this depends on

## Default Value for Unknown Information:

```
TBD (pending functional review)
```

## Placement:

These fields should be inserted immediately before the `**Notes**` field in each screen entry.

## Example Entry Structure:

```markdown
## SCREEN-ID: Screen Name

- **CanonicalId**: MODULE.00.001.A.ROLE.ENV
- **Module**: Module Name
- **Portal(s)**: Portal name
- **Roles with access**: Role list
- **External Route (client URL)**: `/route`
- **Internal/Admin Route (if any)**: N/A or route
- **Dev Route (current project path)**: src/path/Component.tsx
- **Component Path**: src/path/Component.tsx
- **UI Pattern**: Pattern name
- **Tenant Availability**: Tenant
- **Subscreens / Tabs / Modals**: List
- **Status**: ✅ Implemented / 🚧 Placeholder / ❌ Missing
- **Purpose**: What this screen does
- **Primary APIs Used**: API endpoints or TBD
- **DB Tables / Models Used**: Tables accessed or TBD
- **Compliance Notes**: Compliance requirements or TBD
- **Event Triggers**: Events fired or TBD
- **Dependencies**: Dependencies or TBD
- **Notes**: Additional notes
```
