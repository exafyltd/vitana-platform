-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Governance Categories
CREATE TABLE IF NOT EXISTS governance_categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    severity INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

-- 2. Governance Rules
CREATE TABLE IF NOT EXISTS governance_rules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL,
    category_id UUID REFERENCES governance_categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    logic JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rules_category ON governance_rules(category_id);
CREATE INDEX IF NOT EXISTS idx_rules_tenant ON governance_rules(tenant_id);

-- 3. Governance Evaluations
CREATE TABLE IF NOT EXISTS governance_evaluations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL,
    rule_id UUID REFERENCES governance_rules(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
    evaluated_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_evaluations_rule ON governance_evaluations(rule_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_entity ON governance_evaluations(entity_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_tenant ON governance_evaluations(tenant_id);

-- 4. Governance Violations
CREATE TABLE IF NOT EXISTS governance_violations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL,
    rule_id UUID REFERENCES governance_rules(id) ON DELETE SET NULL,
    entity_id TEXT NOT NULL,
    severity INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_violations_status ON governance_violations(status);
CREATE INDEX IF NOT EXISTS idx_violations_tenant ON governance_violations(tenant_id);

-- 5. Governance Enforcements
CREATE TABLE IF NOT EXISTS governance_enforcements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id TEXT NOT NULL,
    rule_id UUID REFERENCES governance_rules(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    executed_at TIMESTAMPTZ DEFAULT NOW(),
    details JSONB
);

CREATE INDEX IF NOT EXISTS idx_enforcements_tenant ON governance_enforcements(tenant_id);

-- RLS Policies
ALTER TABLE governance_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_enforcements ENABLE ROW LEVEL SECURITY;

-- Allow read access to authenticated users
CREATE POLICY "Enable read access for authenticated users" ON governance_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable read access for authenticated users" ON governance_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable read access for authenticated users" ON governance_evaluations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable read access for authenticated users" ON governance_violations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable read access for authenticated users" ON governance_enforcements FOR SELECT TO authenticated USING (true);

-- Allow write access ONLY to service_role (backend)
CREATE POLICY "Enable write access for service role" ON governance_categories FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Enable write access for service role" ON governance_rules FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Enable write access for service role" ON governance_evaluations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Enable write access for service role" ON governance_violations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Enable write access for service role" ON governance_enforcements FOR ALL TO service_role USING (true) WITH CHECK (true);
