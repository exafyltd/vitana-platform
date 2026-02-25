# Vitana Discover HUB Marketplace Research
## Transforming the Discover Shop into a Multi-Vendor Marketplace with Simple API Integration

**Date:** 2026-02-25
**Status:** Research & Architecture Proposal
**Scope:** Investigate how shop owners can integrate their shops/products/services into the Vitana Discover HUB via simple API integration

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Marketplace Vision](#3-marketplace-vision)
4. [Proposed Architecture](#4-proposed-architecture)
5. [API Integration Design for Shop Owners](#5-api-integration-design-for-shop-owners)
6. [Database Schema Extensions](#6-database-schema-extensions)
7. [Vendor Onboarding Flow](#7-vendor-onboarding-flow)
8. [Payment & Commission Architecture](#8-payment--commission-architecture)
9. [Security & Governance](#9-security--governance)
10. [Implementation Phases](#10-implementation-phases)
11. [Industry Research & References](#11-industry-research--references)

---

## 1. Executive Summary

The Vitana Discover HUB currently operates as a **context-aware, memory-first discovery system** (VTID-01092, VTID-01091, VTID-01142). It has foundational building blocks including product/service catalogs, relationship-based recommendations, Stripe Connect integration, and opportunity surfacing engines.

This research proposes extending the Discover HUB into a **multi-vendor marketplace** where external shop owners can:
- Register and onboard their shops via a simple REST API
- Push their product/service catalogs programmatically
- Receive orders and manage fulfillment through webhooks
- Get paid automatically via the existing Stripe Connect infrastructure
- Leverage Vitana's AI-powered discovery and recommendation engine

The proposed design follows an **API-first, headless marketplace** approach that fits naturally within Vitana's existing Express.js/Supabase/OASIS architecture.

---

## 2. Current State Analysis

### 2.1 What Exists Today

| Component | Location | Status |
|-----------|----------|--------|
| **Product Catalog** (`products_catalog`) | `services/gateway/src/routes/offers.ts` | Basic CRUD via RPC |
| **Service Catalog** (`services_catalog`) | `services/gateway/src/routes/offers.ts` | Basic CRUD via RPC |
| **User Offer Memory** (`user_offers_memory`) | `services/gateway/src/routes/offers.ts` | Tracks viewed/saved/used/dismissed/rated |
| **Usage Outcomes** (`usage_outcomes`) | `services/gateway/src/routes/offers.ts` | Tracks perceived impact |
| **Relationship Graph** (`relationship_edges`) | `services/gateway/src/routes/offers.ts` | Strength-based recommendations (-100 to +100) |
| **Stripe Connect** | `services/gateway/src/routes/creators.ts` | Express accounts, onboarding, dashboard |
| **Stripe Webhooks** | `services/gateway/src/routes/stripe-connect-webhook.ts` | Account status tracking |
| **Opportunity Surfacing** (D48) | `services/gateway/src/routes/opportunity-surfacing.ts` | Context-aware discovery engine |
| **Financial Monetization** (D36) | `services/gateway/src/routes/financial-monetization.ts` | Monetization readiness & guardrails |
| **Location Discovery** | `services/gateway/src/routes/locations.ts` | Nearby places/services |
| **Community Matching** | `services/gateway/src/routes/community.ts` | Group/meetup discovery |
| **Matchmaking** | `services/gateway/src/routes/matchmaking.ts` | Service-to-user matching |

### 2.2 Current API Patterns (Must Align With)

```
Authentication:  Bearer JWT (Supabase or Lovable)
Response Format: { ok: boolean, error?: string, data?: T }
Routing:         /api/v1/<domain>/<action>
Validation:      Zod schemas
Events:          OASIS event emission for all state transitions
Database:        Supabase PostgreSQL with RLS, snake_case tables
Tenant Isolation: tenant_id from JWT app_metadata
```

### 2.3 What Is Missing for a Full Marketplace

| Gap | Description |
|-----|-------------|
| **Vendor/Shop entity** | No concept of an external shop/vendor with its own identity, profile, and catalog |
| **Vendor API keys** | No API key system for external integrations (only JWT-based auth today) |
| **Catalog sync API** | No bulk import/sync endpoints for external product feeds |
| **Order management** | No order lifecycle (created -> paid -> fulfilled -> completed) |
| **Shopping cart** | No cart/checkout flow |
| **Inventory tracking** | No stock/availability management |
| **Commission engine** | Basic 90/10 split exists for creators, but no configurable commission model |
| **Vendor dashboard** | No self-service portal for vendors to manage their shop |
| **Search & browse** | No full-text search, filtering, or category browsing for the public catalog |
| **Reviews & ratings** | No public review system (only private trust_score exists) |
| **Webhook delivery** | No outbound webhook system for notifying vendors of orders/events |

---

## 3. Marketplace Vision

### 3.1 The Vitana Marketplace Difference

Unlike traditional marketplaces (Amazon, Etsy), the Vitana Discover HUB marketplace is designed around **context-aware, AI-personalized discovery**:

```
Traditional Marketplace:              Vitana Discover HUB Marketplace:
┌─────────────────────┐              ┌──────────────────────────────────┐
│ Browse → Search     │              │ Context → AI Surfacing          │
│ Filter → Compare    │              │ Memory → Personalized Discovery │
│ Add to Cart → Pay   │              │ Trust Graph → Recommendations   │
│ Review → Rate       │              │ Outcomes → Adaptive Ranking     │
└─────────────────────┘              └──────────────────────────────────┘
```

**Key differentiators:**
- **Context-first discovery**: Products surface based on the user's life context (health, goals, location, relationships), not just search queries
- **Memory-powered recommendations**: The relationship graph (VTID-01092) and memory garden drive what surfaces
- **Outcome-tracked trust**: User-stated outcomes (sleep improved, stress reduced) feed back into ranking
- **Ethical monetization guardrails** (D36): No dark patterns, no urgency manipulation, user-benefit > monetization
- **Multi-domain intelligence**: 24 D-series engines (D28-D51) provide holistic context for discovery

### 3.2 Vendor Value Proposition

Shop owners integrate once and gain access to:
1. **AI-powered customer matching** via Vitana's context engines
2. **Trust-based ranking** where quality products rise naturally through outcome data
3. **Zero-commission discovery** (vendors pay only on transactions, not impressions)
4. **Ethical marketplace guarantees** (no pay-to-play, no promoted listings that override user benefit)
5. **Rich user context** (with consent) for better product-market fit

---

## 4. Proposed Architecture

### 4.1 High-Level Architecture

```
                    ┌──────────────────────────────────────────────────┐
                    │               VITANA DISCOVER HUB                │
                    │            (Marketplace Platform)                │
                    ├──────────────────────────────────────────────────┤
                    │                                                  │
  Shop Owners      │   ┌─────────────┐    ┌──────────────────────┐   │   Vitana Users
  (Vendors)        │   │  Vendor API │    │  Discovery Engine    │   │   (Buyers)
       │           │   │  Gateway    │    │  (D48 + Catalog +    │   │       │
       │           │   │             │    │   AI Matching)       │   │       │
       ▼           │   └──────┬──────┘    └──────────┬───────────┘   │       ▼
  ┌─────────┐      │          │                      │               │  ┌──────────┐
  │ Shop    │ ───► │   ┌──────▼──────────────────────▼───────────┐   │  │ ORB /    │
  │ Owner   │      │   │           Gateway (/api/v1)             │   │  │ Operator │
  │ API     │ ◄─── │   │  offers · marketplace · vendors ·      │   │  │ Console  │
  │ Client  │      │   │  orders · inventory · webhooks          │   │  │ Frontend │
  └─────────┘      │   └──────────────────┬──────────────────────┘   │  └──────────┘
                   │                      │                          │
                   │   ┌──────────────────▼──────────────────────┐   │
                   │   │          Supabase (PostgreSQL)           │   │
                   │   │  vendor_shops · vendor_catalog_items ·   │   │
                   │   │  marketplace_orders · vendor_api_keys ·  │   │
                   │   │  services_catalog · products_catalog     │   │
                   │   └──────────────────┬──────────────────────┘   │
                   │                      │                          │
                   │   ┌──────────────────▼──────────────────────┐   │
                   │   │         Stripe Connect                  │   │
                   │   │  (Payment Split & Vendor Payouts)       │   │
                   │   └─────────────────────────────────────────┘   │
                   │                                                  │
                   └──────────────────────────────────────────────────┘
```

### 4.2 Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    NEW MARKETPLACE COMPONENTS                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Layer 1: Vendor Integration API                                    │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ vendor-api-routes.ts      - REST endpoints for shop owners     │ │
│  │ vendor-auth-middleware.ts - API key authentication              │ │
│  │ vendor-webhook-service.ts - Outbound webhook delivery          │ │
│  │ vendor-catalog-sync.ts   - Bulk catalog import/sync            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Layer 2: Marketplace Core                                          │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ marketplace-service.ts   - Shop management business logic      │ │
│  │ order-service.ts         - Order lifecycle management          │ │
│  │ inventory-service.ts     - Stock tracking & availability       │ │
│  │ commission-engine.ts     - Configurable commission calculation  │ │
│  │ marketplace-search.ts   - Full-text search & filtering         │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Layer 3: Integration with Existing Systems                         │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ D48 Opportunity Surfacing  → surfaces vendor products          │ │
│  │ D36 Financial Monetization → ethical monetization guardrails   │ │
│  │ Relationship Graph         → vendor/product trust scoring      │ │
│  │ OASIS Events               → marketplace event tracking        │ │
│  │ Stripe Connect             → vendor payment & commission split │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  EXISTING COMPONENTS (Enhanced, Not Replaced)                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ offers.ts                 → extended with vendor_id support    │ │
│  │ creators.ts               → extended for vendor onboarding     │ │
│  │ stripe-connect-webhook.ts → extended for order payments        │ │
│  │ opportunity-surfacing.ts  → enhanced with vendor catalog feed  │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. API Integration Design for Shop Owners

### 5.1 Design Principles

1. **Simple onboarding**: Register shop and get API key in one call
2. **Familiar REST patterns**: Standard CRUD with JSON payloads
3. **Minimal required fields**: Only essential data required; metadata is flexible
4. **Webhook-driven**: Vendors receive events (new orders, status changes) via webhooks
5. **Idempotent operations**: Safe to retry (external_id-based deduplication)
6. **Batch support**: Bulk operations for catalog management

### 5.2 Vendor API Endpoints

#### Authentication
Vendors authenticate using API keys (not JWT), issued during onboarding:

```
Header: X-Vendor-API-Key: vk_live_xxxxxxxxxxxxxxxxxxxx
```

#### Shop Management

```http
# Register a new shop (requires Vitana user JWT for initial setup)
POST /api/v1/marketplace/shops
Authorization: Bearer <user-jwt>
{
  "shop_name": "Zen Wellness Studio",
  "shop_type": "wellness",              // wellness | nutrition | fitness | tech | lifestyle | other
  "description": "Holistic wellness services and products",
  "website_url": "https://zenwellness.com",
  "logo_url": "https://zenwellness.com/logo.png",
  "contact_email": "shop@zenwellness.com",
  "categories": ["wellness", "therapy", "nutrition"],
  "metadata": {
    "business_registration": "DE123456789",
    "country": "DE"
  }
}
→ Response: { ok: true, shop_id: "uuid", api_key: "vk_live_xxx", api_secret: "vs_live_xxx" }

# Get shop profile
GET /api/v1/marketplace/shops/:shop_id
X-Vendor-API-Key: vk_live_xxx

# Update shop profile
PATCH /api/v1/marketplace/shops/:shop_id
X-Vendor-API-Key: vk_live_xxx

# Get shop dashboard/stats
GET /api/v1/marketplace/shops/:shop_id/stats
X-Vendor-API-Key: vk_live_xxx
```

#### Catalog Management (Products & Services)

```http
# Add a single product/service
POST /api/v1/marketplace/catalog/items
X-Vendor-API-Key: vk_live_xxx
{
  "external_id": "SKU-YOGA-MAT-001",    // Vendor's own ID (for sync)
  "type": "product",                     // product | service
  "name": "Premium Yoga Mat",
  "description": "Eco-friendly cork yoga mat, 6mm thick",
  "category": "fitness",
  "subcategory": "yoga",
  "price": {
    "amount": 4900,                      // In cents
    "currency": "EUR"
  },
  "images": [
    { "url": "https://...", "alt": "Yoga mat front view", "primary": true }
  ],
  "attributes": {
    "material": "Cork",
    "thickness": "6mm",
    "dimensions": "183cm x 61cm",
    "weight": "2.5kg",
    "eco_certified": true
  },
  "topic_keys": ["fitness", "yoga", "wellness"],   // Maps to Vitana's topic system
  "availability": {
    "in_stock": true,
    "quantity": 150
  },
  "metadata": {}                         // Any additional vendor-specific data
}
→ Response: { ok: true, item_id: "uuid", external_id: "SKU-YOGA-MAT-001" }

# Bulk catalog sync (upsert by external_id)
POST /api/v1/marketplace/catalog/sync
X-Vendor-API-Key: vk_live_xxx
{
  "items": [ ... ],                      // Array of items (max 100 per request)
  "sync_mode": "upsert"                 // upsert | replace_all
}
→ Response: { ok: true, created: 12, updated: 5, errors: [] }

# Update a catalog item
PATCH /api/v1/marketplace/catalog/items/:item_id
X-Vendor-API-Key: vk_live_xxx

# Update by external ID
PATCH /api/v1/marketplace/catalog/items/external/:external_id
X-Vendor-API-Key: vk_live_xxx

# Remove a catalog item
DELETE /api/v1/marketplace/catalog/items/:item_id
X-Vendor-API-Key: vk_live_xxx

# List catalog items (with pagination)
GET /api/v1/marketplace/catalog/items?page=1&limit=50&category=fitness
X-Vendor-API-Key: vk_live_xxx

# Update inventory/availability
PATCH /api/v1/marketplace/catalog/items/:item_id/inventory
X-Vendor-API-Key: vk_live_xxx
{
  "in_stock": true,
  "quantity": 120
}

# Bulk inventory update
POST /api/v1/marketplace/catalog/inventory/sync
X-Vendor-API-Key: vk_live_xxx
{
  "updates": [
    { "external_id": "SKU-001", "quantity": 120, "in_stock": true },
    { "external_id": "SKU-002", "quantity": 0, "in_stock": false }
  ]
}
```

#### Order Management (Vendor Side)

```http
# List orders for the shop
GET /api/v1/marketplace/orders?status=pending&page=1&limit=20
X-Vendor-API-Key: vk_live_xxx

# Get order details
GET /api/v1/marketplace/orders/:order_id
X-Vendor-API-Key: vk_live_xxx

# Update order status (vendor fulfillment)
PATCH /api/v1/marketplace/orders/:order_id/status
X-Vendor-API-Key: vk_live_xxx
{
  "status": "shipped",                  // confirmed | processing | shipped | delivered | cancelled
  "tracking_number": "DHL-1234567890",
  "tracking_url": "https://tracking.dhl.com/...",
  "notes": "Shipped via DHL Express"
}

# Issue a refund
POST /api/v1/marketplace/orders/:order_id/refund
X-Vendor-API-Key: vk_live_xxx
{
  "amount": 4900,                        // Partial or full refund in cents
  "reason": "Customer requested return"
}
```

#### Webhook Management

```http
# Register a webhook endpoint
POST /api/v1/marketplace/webhooks
X-Vendor-API-Key: vk_live_xxx
{
  "url": "https://zenwellness.com/api/vitana-webhook",
  "events": [
    "order.created",
    "order.paid",
    "order.cancelled",
    "order.refund_requested",
    "review.created"
  ],
  "secret": "whsec_vendor_supplied_secret"    // For HMAC signature verification
}

# List webhooks
GET /api/v1/marketplace/webhooks
X-Vendor-API-Key: vk_live_xxx

# Delete a webhook
DELETE /api/v1/marketplace/webhooks/:webhook_id
X-Vendor-API-Key: vk_live_xxx
```

### 5.3 Webhook Event Payloads (Outbound to Vendors)

```json
// POST https://vendor-endpoint.com/vitana-webhook
// Headers:
//   X-Vitana-Signature: sha256=xxxxxx (HMAC of body with vendor's webhook secret)
//   X-Vitana-Event: order.created
//   X-Vitana-Delivery-ID: uuid

// order.created
{
  "event": "order.created",
  "timestamp": "2026-02-25T12:00:00Z",
  "data": {
    "order_id": "uuid",
    "shop_id": "uuid",
    "items": [
      {
        "item_id": "uuid",
        "external_id": "SKU-YOGA-MAT-001",
        "name": "Premium Yoga Mat",
        "quantity": 1,
        "unit_price": 4900,
        "currency": "EUR"
      }
    ],
    "total_amount": 4900,
    "commission_amount": 735,            // Platform commission (15%)
    "vendor_payout": 4165,               // Amount vendor receives
    "currency": "EUR",
    "buyer": {
      "name": "User Display Name",       // Only with consent
      "shipping_address": { ... }         // Only for physical products
    },
    "created_at": "2026-02-25T12:00:00Z"
  }
}

// order.paid
{
  "event": "order.paid",
  "timestamp": "2026-02-25T12:01:00Z",
  "data": {
    "order_id": "uuid",
    "payment_status": "paid",
    "paid_at": "2026-02-25T12:01:00Z"
  }
}
```

### 5.4 Discovery API (Buyer/Consumer Side)

```http
# Browse marketplace catalog (public, authenticated)
GET /api/v1/marketplace/discover?category=wellness&q=yoga&limit=20
Authorization: Bearer <user-jwt>
→ Response: {
    ok: true,
    items: [...],
    facets: { categories: [...], price_range: { min, max }, shops: [...] },
    personalization: { reason: "Based on your wellness goals" }
  }

# Get item details
GET /api/v1/marketplace/items/:item_id
Authorization: Bearer <user-jwt>

# Get shop storefront
GET /api/v1/marketplace/shops/:shop_id/storefront
Authorization: Bearer <user-jwt>

# AI-powered contextual discovery (integrates with D48)
POST /api/v1/marketplace/discover/contextual
Authorization: Bearer <user-jwt>
{
  "context": "I want to improve my sleep quality",
  "budget_range": { "min": 0, "max": 10000 },
  "preferences": { "eco_friendly": true }
}
→ Response: {
    ok: true,
    recommendations: [
      {
        item_id: "uuid",
        name: "Organic Sleep Tea",
        shop_name: "Natural Remedies Co.",
        price: { amount: 1499, currency: "EUR" },
        relevance_score: 0.92,
        why_recommended: "Matches your sleep improvement goal; 87% of similar users reported better sleep"
      }
    ]
  }
```

---

## 6. Database Schema Extensions

### 6.1 New Tables

```sql
-- ============================================================================
-- VENDOR SHOPS - The shop/vendor entity
-- ============================================================================
CREATE TABLE vendor_shops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,                          -- Vitana tenant
  owner_user_id UUID NOT NULL,                      -- Vitana user who owns the shop
  shop_name TEXT NOT NULL,
  shop_slug TEXT NOT NULL UNIQUE,                   -- URL-friendly identifier
  shop_type TEXT NOT NULL,                          -- wellness | nutrition | fitness | tech | lifestyle | other
  description TEXT,
  website_url TEXT,
  logo_url TEXT,
  contact_email TEXT NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',

  -- Stripe Connect
  stripe_account_id TEXT,                           -- Stripe Connect account
  stripe_charges_enabled BOOLEAN DEFAULT FALSE,
  stripe_payouts_enabled BOOLEAN DEFAULT FALSE,
  stripe_onboarded_at TIMESTAMPTZ,

  -- Commission
  commission_rate NUMERIC(5,4) DEFAULT 0.1500,     -- Default 15% platform commission
  commission_model TEXT DEFAULT 'percentage',        -- percentage | fixed | tiered

  -- Status
  status TEXT NOT NULL DEFAULT 'pending_review',    -- pending_review | active | suspended | closed
  verified_at TIMESTAMPTZ,

  -- Metadata
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: Shop owners can manage their own shops
ALTER TABLE vendor_shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_shops_owner ON vendor_shops
  USING (owner_user_id = auth.uid() AND tenant_id = current_tenant_id());

-- ============================================================================
-- VENDOR API KEYS - API key authentication for external integrations
-- ============================================================================
CREATE TABLE vendor_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES vendor_shops(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,                         -- First 8 chars for identification (vk_live_)
  key_hash TEXT NOT NULL,                           -- SHA-256 hash of the full key
  name TEXT NOT NULL DEFAULT 'Default',             -- Key name/label
  scopes TEXT[] NOT NULL DEFAULT '{catalog,orders,webhooks}',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,                           -- Optional expiration
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendor_api_keys_hash ON vendor_api_keys(key_hash) WHERE is_active = TRUE;
CREATE INDEX idx_vendor_api_keys_shop ON vendor_api_keys(shop_id);

-- ============================================================================
-- VENDOR CATALOG ITEMS - Extended product/service catalog with vendor ownership
-- ============================================================================
CREATE TABLE vendor_catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES vendor_shops(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  external_id TEXT,                                 -- Vendor's own SKU/ID

  -- Item details
  type TEXT NOT NULL,                               -- product | service
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  subcategory TEXT,

  -- Pricing
  price_amount INTEGER NOT NULL,                    -- In cents
  price_currency TEXT NOT NULL DEFAULT 'EUR',
  compare_at_price INTEGER,                         -- Original price (for discounts)

  -- Media
  images JSONB NOT NULL DEFAULT '[]',               -- Array of {url, alt, primary}

  -- Attributes & classification
  attributes JSONB NOT NULL DEFAULT '{}',           -- Flexible key-value attributes
  topic_keys TEXT[] NOT NULL DEFAULT '{}',          -- Maps to Vitana topic system
  tags TEXT[] NOT NULL DEFAULT '{}',

  -- Availability
  in_stock BOOLEAN DEFAULT TRUE,
  quantity INTEGER,                                 -- NULL = unlimited (services)

  -- Marketplace scoring
  trust_score NUMERIC(5,2) DEFAULT 0,              -- Computed from outcomes
  discovery_score NUMERIC(5,2) DEFAULT 0,           -- Computed from engagement
  outcome_count INTEGER DEFAULT 0,
  positive_outcome_ratio NUMERIC(5,4) DEFAULT 0,

  -- Status
  status TEXT NOT NULL DEFAULT 'active',            -- draft | active | paused | archived
  published_at TIMESTAMPTZ,

  -- Deduplication
  UNIQUE(shop_id, external_id),

  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vendor_catalog_shop ON vendor_catalog_items(shop_id, status);
CREATE INDEX idx_vendor_catalog_category ON vendor_catalog_items(category, status) WHERE status = 'active';
CREATE INDEX idx_vendor_catalog_topic ON vendor_catalog_items USING gin(topic_keys);
CREATE INDEX idx_vendor_catalog_search ON vendor_catalog_items USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));

-- RLS: Public read for active items, shop owner write
ALTER TABLE vendor_catalog_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_catalog_read ON vendor_catalog_items
  FOR SELECT USING (status = 'active' AND tenant_id = current_tenant_id());

-- ============================================================================
-- MARKETPLACE ORDERS - Order lifecycle management
-- ============================================================================
CREATE TABLE marketplace_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  buyer_user_id UUID NOT NULL,
  shop_id UUID NOT NULL REFERENCES vendor_shops(id),

  -- Order details
  order_number TEXT NOT NULL UNIQUE,                -- Human-readable order number
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | paid | confirmed | processing | shipped | delivered | completed | cancelled | refunded

  -- Financial
  subtotal INTEGER NOT NULL,                        -- In cents
  commission_amount INTEGER NOT NULL,               -- Platform commission in cents
  vendor_payout_amount INTEGER NOT NULL,            -- Vendor receives this
  currency TEXT NOT NULL DEFAULT 'EUR',

  -- Stripe
  stripe_payment_intent_id TEXT,
  stripe_transfer_id TEXT,                          -- Transfer to vendor
  paid_at TIMESTAMPTZ,

  -- Fulfillment
  shipping_address JSONB,
  tracking_number TEXT,
  tracking_url TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,

  -- Items snapshot
  items JSONB NOT NULL DEFAULT '[]',                -- Snapshot of ordered items

  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_marketplace_orders_buyer ON marketplace_orders(buyer_user_id, created_at DESC);
CREATE INDEX idx_marketplace_orders_shop ON marketplace_orders(shop_id, status);
CREATE INDEX idx_marketplace_orders_status ON marketplace_orders(status, created_at DESC);

-- RLS
ALTER TABLE marketplace_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_buyer ON marketplace_orders
  FOR SELECT USING (buyer_user_id = auth.uid() AND tenant_id = current_tenant_id());

-- ============================================================================
-- VENDOR WEBHOOKS - Outbound webhook configuration
-- ============================================================================
CREATE TABLE vendor_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES vendor_shops(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}',              -- Which events to send
  secret_hash TEXT NOT NULL,                        -- Hashed webhook secret for HMAC
  is_active BOOLEAN DEFAULT TRUE,
  last_delivery_at TIMESTAMPTZ,
  last_delivery_status TEXT,                        -- success | failed
  failure_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- VENDOR WEBHOOK DELIVERIES - Delivery log for debugging
-- ============================================================================
CREATE TABLE vendor_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES vendor_webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  delivered_at TIMESTAMPTZ,
  attempts INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | delivered | failed | expired
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_pending ON vendor_webhook_deliveries(status, next_retry_at)
  WHERE status = 'pending';
```

### 6.2 Existing Table Enhancements

```sql
-- Add vendor reference to existing catalogs
ALTER TABLE services_catalog ADD COLUMN vendor_shop_id UUID REFERENCES vendor_shops(id);
ALTER TABLE products_catalog ADD COLUMN vendor_shop_id UUID REFERENCES vendor_shops(id);

-- Add marketplace fields to relationship_edges
-- (relationship_edges already supports target_type: service | product)
-- No schema change needed - vendor items flow through existing graph

-- Add vendor catalog as opportunity source in contextual_opportunities
-- (already supports external_id and external_type fields)
-- No schema change needed
```

---

## 7. Vendor Onboarding Flow

### 7.1 Self-Service Onboarding

```
Step 1: Vitana User Registration
  └── User signs up on Vitana platform (existing Supabase Auth)

Step 2: Shop Registration
  └── POST /api/v1/marketplace/shops
      ├── Creates vendor_shops record (status: pending_review)
      ├── Generates API key pair (vk_live_xxx / vs_live_xxx)
      └── Emits OASIS event: marketplace.shop.registered

Step 3: Platform Review (Automated + Manual)
  └── Automated checks:
      ├── Email verification
      ├── Business details validation
      └── Category appropriateness check
  └── Manual review (for first-time vendors):
      ├── Content policy compliance
      └── Shop quality assessment
  └── Status → active
  └── Emits OASIS event: marketplace.shop.approved

Step 4: Stripe Connect Onboarding
  └── POST /api/v1/creators/onboard (existing endpoint, extended)
      ├── Creates Stripe Express Connected Account
      ├── Returns onboarding URL
      └── Webhook updates stripe_charges_enabled / stripe_payouts_enabled

Step 5: Catalog Upload
  └── POST /api/v1/marketplace/catalog/sync
      ├── Vendor pushes their product/service catalog
      ├── Items validated against Zod schemas
      ├── Topic keys mapped to Vitana topic system
      └── Items immediately available in Discover HUB

Step 6: Webhook Configuration
  └── POST /api/v1/marketplace/webhooks
      └── Vendor registers endpoints for order notifications
```

### 7.2 Integration Complexity Levels

| Level | Description | Effort | Use Case |
|-------|-------------|--------|----------|
| **Level 1: Manual** | Use Vitana dashboard to add products one-by-one | No code | Small shops, <50 items |
| **Level 2: Catalog Sync** | Push catalog via `/catalog/sync` API | 1 API call | Medium shops, periodic sync |
| **Level 3: Real-time** | Full API integration with webhooks | REST client | Large shops, real-time inventory |
| **Level 4: Platform Plugin** | Shopify/WooCommerce plugin auto-syncs | Install plugin | Shops already on e-commerce platforms |

---

## 8. Payment & Commission Architecture

### 8.1 Payment Flow

```
Buyer Checkout
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. Create Stripe PaymentIntent                                 │
│     amount: order total                                         │
│     application_fee_amount: commission (configurable %)          │
│     transfer_data.destination: vendor's Stripe Connect account  │
│     on_behalf_of: vendor's Stripe Connect account               │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Payment Confirmed (via Stripe webhook)                      │
│     → Update order status to 'paid'                             │
│     → Notify vendor via webhook (order.paid)                    │
│     → Emit OASIS event: marketplace.order.paid                  │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Automatic Fund Split (Stripe handles this)                  │
│     → Vendor receives: order_amount - commission                │
│     → Platform receives: commission (application_fee)           │
│     → Payout schedule: Stripe Express default (rolling basis)   │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 Commission Model

```typescript
// Configurable per-vendor commission rates
interface CommissionConfig {
  model: 'percentage' | 'fixed' | 'tiered';

  // Percentage model (default)
  percentage_rate: number;     // e.g., 0.15 = 15%

  // Tiered model (volume-based)
  tiers?: Array<{
    up_to: number;             // Monthly GMV threshold
    rate: number;              // Commission rate for this tier
  }>;

  // Fixed model
  fixed_amount?: number;       // Fixed per-transaction fee in cents
}

// Default: 15% platform commission
// Creator rooms (existing): 10% platform commission (90% to creator)
// Configurable per vendor based on category, volume, partnership level
```

### 8.3 Leveraging Existing Stripe Connect

The platform already has Stripe Connect Express integration (`services/gateway/src/routes/creators.ts`). The marketplace extends this:

| Existing (VTID-01231) | Marketplace Extension |
|------------------------|-----------------------|
| `POST /api/v1/creators/onboard` | Reuse for vendor onboarding |
| `GET /api/v1/creators/status` | Extend with shop-specific data |
| `GET /api/v1/creators/dashboard` | Works as-is for vendor payouts |
| `POST /api/v1/stripe/webhook/connect` | Extend with order payment events |
| 90/10 split (hardcoded) | Configurable per-vendor commission |

---

## 9. Security & Governance

### 9.1 Vendor API Key Security

```
Key Format:   vk_live_<32 random chars>   (live key)
              vk_test_<32 random chars>   (test key)
Secret:       vs_live_<32 random chars>   (used for webhook signing)

Storage:      Only SHA-256 hash stored in database
              Full key shown ONCE at creation time
              Prefix stored for identification (first 8 chars)

Rate Limits:  100 requests/minute per API key (catalog operations)
              20 requests/minute per API key (order operations)
              3 onboarding attempts/hour (existing rate limit)

Rotation:     POST /api/v1/marketplace/shops/:shop_id/keys/rotate
              Old key valid for 24h grace period after rotation
```

### 9.2 OASIS Event Governance

All marketplace operations emit OASIS events per existing platform rules:

```typescript
// Marketplace event taxonomy
'marketplace.shop.registered'     // New shop registered
'marketplace.shop.approved'       // Shop approved and active
'marketplace.shop.suspended'      // Shop suspended
'marketplace.catalog.synced'      // Catalog bulk sync completed
'marketplace.catalog.item.created'// Single item added
'marketplace.catalog.item.updated'// Item updated
'marketplace.order.created'       // New order placed
'marketplace.order.paid'          // Payment confirmed
'marketplace.order.fulfilled'     // Order shipped/delivered
'marketplace.order.cancelled'     // Order cancelled
'marketplace.order.refunded'      // Refund processed
'marketplace.commission.earned'   // Commission collected
'marketplace.webhook.delivered'   // Webhook successfully delivered
'marketplace.webhook.failed'      // Webhook delivery failed
```

### 9.3 Content & Quality Governance

```
Automated Gates:
├── Catalog item validation (Zod schema)
├── Image URL validation (no inline base64, HTTPS only)
├── Price sanity check (within category range)
├── Description quality check (minimum length, no spam patterns)
├── Duplicate detection (name + category + shop_id)
└── Topic key validation (must exist in Vitana topic registry)

Ethical Guardrails (extends D36):
├── No health claims without certification flag
├── No urgency/scarcity manipulation in descriptions
├── Price history transparency (compare_at_price validation)
├── No pay-to-rank (discovery purely by relevance + outcomes)
└── User-benefit > monetization (inherited from D48 governance)
```

### 9.4 Data Isolation

```
Vendor data isolation:
├── Vendors see ONLY their own shop data (RLS on shop_id)
├── Vendors NEVER see buyer personal data (only order-necessary info)
├── Buyer browsing data is NOT shared with vendors
├── Outcome/trust data is aggregated, never individual

Multi-tenant isolation (existing):
├── All tables have tenant_id
├── RLS enforced at database level
├── JWT contains tenant context
└── Service role only for internal operations
```

---

## 10. Implementation Phases

### Phase 1: Foundation (Vendor Registration & Catalog API)

**New files:**
- `services/gateway/src/routes/marketplace-vendor.ts` - Shop registration, API key management
- `services/gateway/src/routes/marketplace-catalog.ts` - Catalog CRUD & sync
- `services/gateway/src/middleware/vendor-api-key-auth.ts` - API key authentication middleware
- `services/gateway/src/services/marketplace-service.ts` - Marketplace business logic

**Database:**
- `vendor_shops` table
- `vendor_api_keys` table
- `vendor_catalog_items` table

**What it enables:**
- Vendors can register shops
- Vendors can push product/service catalogs via API
- Catalog items appear in existing Discover HUB discovery

**Integration points:**
- Topic keys map to existing topic system (`services/gateway/src/routes/topics.ts`)
- Catalog items feed into D48 Opportunity Surfacing as a new source
- Items appear in `/api/v1/offers/recommendations` alongside existing catalog

---

### Phase 2: Discovery & Search

**New files:**
- `services/gateway/src/routes/marketplace-discover.ts` - Browse, search, filter
- `services/gateway/src/services/marketplace-search.ts` - Full-text search engine

**Enhancements:**
- Extend D48 engine to include vendor catalog items as opportunity source
- Add marketplace items to relationship graph scoring
- Implement faceted search (category, price range, vendor, rating)

**What it enables:**
- Users can browse and search the marketplace catalog
- AI-powered contextual discovery recommends vendor items
- Existing trust graph and outcome tracking applies to vendor items

---

### Phase 3: Orders & Payments

**New files:**
- `services/gateway/src/routes/marketplace-orders.ts` - Order creation, status, fulfillment
- `services/gateway/src/services/order-service.ts` - Order lifecycle
- `services/gateway/src/services/commission-engine.ts` - Commission calculation

**Database:**
- `marketplace_orders` table

**Enhancements:**
- Extend Stripe Connect webhook handler for payment intents
- Extend creators.ts onboarding for vendor-specific flows
- Configurable commission rates per vendor

**What it enables:**
- Full checkout and payment flow
- Automatic commission split via Stripe Connect
- Order tracking for buyers and vendors

---

### Phase 4: Vendor Webhooks & Real-time Sync

**New files:**
- `services/gateway/src/services/vendor-webhook-service.ts` - Outbound webhook delivery
- `services/gateway/src/routes/marketplace-webhooks.ts` - Webhook CRUD

**Database:**
- `vendor_webhooks` table
- `vendor_webhook_deliveries` table

**What it enables:**
- Vendors receive real-time order notifications
- Automatic retry with exponential backoff
- Delivery logging for debugging

---

### Phase 5: Advanced Features

- **Vendor Dashboard UI** in frontend (Lovable)
- **Platform Plugin SDK** for Shopify/WooCommerce auto-sync
- **Reviews & Ratings** public review system
- **Analytics Dashboard** for vendors (sales, traffic, conversion)
- **Tiered Commission** volume-based commission tiers
- **Promotional Tools** (within ethical guardrails)

---

## 11. Industry Research & References

### 11.1 Market Context

- 67% of all online sales now flow through marketplaces (up from 58% in 2023)
- Multi-vendor marketplace services market: $57.22B in 2025, projected $68.52B
- 73% of businesses operate on headless/API-first architecture
- API-first approach yields 50% performance improvements and 47% ROI increases

### 11.2 Key Architectural Patterns Referenced

| Pattern | Application to Vitana |
|---------|----------------------|
| **API-First Headless Commerce** | Vendor API is headless - any frontend can consume it |
| **Composable Architecture** | Marketplace components are independent, composable services |
| **Event-Driven Sync** | OASIS events + webhooks for real-time coordination |
| **Unified API Layer** | Single gateway handles both vendor and consumer APIs |
| **Multi-Tenant Isolation** | Existing RLS-based tenant isolation extends to marketplace |
| **Strangler Fig Migration** | New marketplace tables extend (not replace) existing catalogs |

### 11.3 Reference Platforms

| Platform | Relevant Pattern |
|----------|-----------------|
| **Stripe Connect** | Already integrated; destination charges with application fees |
| **Shopify** | REST + GraphQL catalog APIs; webhook-driven order flow |
| **Marketplacer** | Enterprise connector with SOC 2 compliance; REST + GraphQL + webhooks |
| **Square Catalog API** | Itemized catalog with automatic tax/discount; inventory sync |

### 11.4 Sources

- [API Integration Guide 2026 - BizData360](https://www.bizdata360.com/api-integration-marketplaces-ultimate-guide-2025/)
- [Best Marketplace APIs 2026 - API2Cart](https://api2cart.com/api-technology/top-10-best-marketplace-apis/)
- [Marketplace API Integration - API2Cart](https://api2cart.com/api-technology/marketplace-api-integration/)
- [BigCommerce Multi-Vendor API Solutions - FlxPoint](https://flxpoint.com/blog/bigcommerce-multi-vendor-marketplace-api-first-solutions)
- [Stripe Connect Documentation](https://docs.stripe.com/connect)
- [Build a Marketplace with Stripe](https://docs.stripe.com/connect/marketplace)
- [Multi-Vendor Payment Orchestration - Nautical Commerce](https://www.nauticalcommerce.com/blog/multi-vendor-payment-orchestration)
- [20 Things for Multi-Vendor Marketplaces - Spree Commerce](https://spreecommerce.org/20-things-to-keep-in-mind-when-building-a-multi-vendor-marketplace/)
- [Enterprise Marketplace Connector - Marketplacer](https://marketplacer.com/enterprise-marketplace-connector/)
- [Multi-Tenant SaaS Inventory on AWS - WeblineIndia](https://www.weblineindia.com/blog/multi-tenant-saas-inventory-system-on-aws/)
- [Split Payments in eCommerce - CS-Cart](https://www.cs-cart.com/blog/split-payments/)
- [eCommerce API Guide - Square](https://developer.squareup.com/docs/ecommerce-api)

---

## Appendix A: API Summary Table

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/marketplace/shops` | POST | JWT | Register a new shop |
| `/api/v1/marketplace/shops/:id` | GET | API Key | Get shop profile |
| `/api/v1/marketplace/shops/:id` | PATCH | API Key | Update shop profile |
| `/api/v1/marketplace/shops/:id/stats` | GET | API Key | Get shop statistics |
| `/api/v1/marketplace/shops/:id/keys/rotate` | POST | API Key | Rotate API key |
| `/api/v1/marketplace/catalog/items` | POST | API Key | Add catalog item |
| `/api/v1/marketplace/catalog/items` | GET | API Key | List catalog items |
| `/api/v1/marketplace/catalog/items/:id` | PATCH | API Key | Update catalog item |
| `/api/v1/marketplace/catalog/items/:id` | DELETE | API Key | Remove catalog item |
| `/api/v1/marketplace/catalog/sync` | POST | API Key | Bulk catalog sync |
| `/api/v1/marketplace/catalog/inventory/sync` | POST | API Key | Bulk inventory update |
| `/api/v1/marketplace/orders` | GET | API Key | List orders (vendor) |
| `/api/v1/marketplace/orders/:id` | GET | API Key | Get order details |
| `/api/v1/marketplace/orders/:id/status` | PATCH | API Key | Update order status |
| `/api/v1/marketplace/orders/:id/refund` | POST | API Key | Issue refund |
| `/api/v1/marketplace/webhooks` | POST | API Key | Register webhook |
| `/api/v1/marketplace/webhooks` | GET | API Key | List webhooks |
| `/api/v1/marketplace/webhooks/:id` | DELETE | API Key | Delete webhook |
| `/api/v1/marketplace/discover` | GET | JWT | Browse/search marketplace |
| `/api/v1/marketplace/discover/contextual` | POST | JWT | AI-powered discovery |
| `/api/v1/marketplace/items/:id` | GET | JWT | Get item details |
| `/api/v1/marketplace/shops/:id/storefront` | GET | JWT | View shop storefront |

## Appendix B: Alignment with Existing Vitana Rules

| Vitana Rule | Marketplace Compliance |
|-------------|----------------------|
| ALWAYS treat OASIS as single source of truth | All marketplace events emitted to OASIS |
| ALWAYS use Supabase as persistent data store | All new tables in Supabase PostgreSQL |
| ALWAYS enforce tenant isolation (RLS) | RLS policies on all marketplace tables |
| ALWAYS use snake_case table names | All tables follow convention |
| ALWAYS route DB mutations through Gateway APIs | All writes go through Gateway routes |
| NEVER mix tenant data | tenant_id on every table, RLS enforced |
| NEVER bypass RLS | Service role only for internal operations |
| User-benefit > monetization (D48) | Discovery ranked by relevance, not payment |
| No dark patterns (D36/D48) | No urgency, no scarcity, no pay-to-rank |
| Explainability mandatory (D48) | All recommendations include "why" |
