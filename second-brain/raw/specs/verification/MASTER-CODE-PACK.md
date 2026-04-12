# MASTER CODE PACK: Stripe Connect Integration (VTID-01230)

**To Lovable:** Please use the following code blocks to create the 4 new files and modify the 3 existing files. This code is already verified and connected to the live Gateway.

---

## 🆕 1. Create `src/hooks/useCreator.ts`
```typescript
/**
 * Creator Hooks - Stripe Connect Express Integration
 * VTID-01230: Enable creators to receive payments
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

const GATEWAY_BASE = import.meta.env.VITE_GATEWAY_BASE || 'https://gateway-q74ibpv6ia-uc.a.run.app';

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }
  return session.access_token;
}

export interface CreatorStatus {
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  onboarded_at: string | null;
}

export function useCreatorStatus() {
  return useQuery({
    queryKey: ['creator', 'status'],
    queryFn: async (): Promise<CreatorStatus> => {
      const token = await getToken();
      const response = await fetch(`${GATEWAY_BASE}/api/v1/creators/status`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch creator status');
      }

      const data = await response.json();
      return {
        stripe_account_id: data.stripe_account_id,
        charges_enabled: data.charges_enabled || false,
        payouts_enabled: data.payouts_enabled || false,
        onboarded_at: data.onboarded_at,
      };
    },
    staleTime: 60 * 1000,
  });
}

export function useCreatorOnboard() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (returnUrl?: string) => {
      const token = await getToken();
      const response = await fetch(`${GATEWAY_BASE}/api/v1/creators/onboard`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          return_url: returnUrl || `${window.location.origin}/creator/onboarded`,
          refresh_url: `${window.location.origin}/creator/onboard`,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to start onboarding');
      }

      const data = await response.json();
      return data.onboarding_url;
    },
    onSuccess: (onboardingUrl) => {
      window.location.href = onboardingUrl;
    },
    onError: (error: Error) => {
      toast({
        title: 'Onboarding failed',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}

export function useCreatorDashboard() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const response = await fetch(`${GATEWAY_BASE}/api/v1/creators/dashboard`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to get dashboard link');
      }

      const data = await response.json();
      return data.dashboard_url;
    },
    onSuccess: (dashboardUrl) => {
      window.open(dashboardUrl, '_blank');
    },
    onError: (error: Error) => {
      toast({
        title: 'Dashboard unavailable',
        description: error.message,
        variant: 'destructive',
      });
    },
  });
}
```

---

## 🆕 2. Create `src/components/creator/EnablePaymentsButton.tsx`
```typescript
import { Button } from '@/components/ui/button';
import { useCreatorStatus, useCreatorOnboard } from '@/hooks/useCreator';
import { CreditCard, CheckCircle, Loader2 } from 'lucide-react';

export function EnablePaymentsButton() {
  const { data: status, isLoading } = useCreatorStatus();
  const { mutate: startOnboarding, isPending } = useCreatorOnboard();

  if (isLoading) {
    return (
      <Button disabled variant="outline">
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        Checking status...
      </Button>
    );
  }

  if (status?.charges_enabled && status?.payouts_enabled) {
    return (
      <div className="flex items-center gap-2 text-green-600 text-sm">
        <CheckCircle className="w-4 h-4" />
        <span className="font-medium">Payments Enabled</span>
      </div>
    );
  }

  if (status?.stripe_account_id && !status?.charges_enabled) {
    return (
      <Button 
        onClick={() => startOnboarding()}
        disabled={isPending}
        variant="outline"
        className="border-yellow-500 text-yellow-700"
      >
        <CreditCard className="w-4 h-4 mr-2" />
        {isPending ? 'Redirecting...' : 'Complete Setup'}
      </Button>
    );
  }

  return (
    <Button 
      onClick={() => startOnboarding()}
      disabled={isPending}
      variant="default"
    >
      <CreditCard className="w-4 h-4 mr-2" />
      {isPending ? 'Redirecting...' : 'Enable Payments'}
    </Button>
  );
}
```

---

## 🆕 3. Create `src/components/creator/CreatorPaymentsSection.tsx`
```typescript
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCreatorStatus, useCreatorDashboard } from '@/hooks/useCreator';
import { EnablePaymentsButton } from './EnablePaymentsButton';
import { DollarSign, ExternalLink, CheckCircle, AlertCircle, Clock } from 'lucide-react';

export function CreatorPaymentsSection() {
  const { data: status, isLoading } = useCreatorStatus();
  const { mutate: openDashboard, isPending: isDashboardLoading } = useCreatorDashboard();

  if (isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>Creator Payments</CardTitle></CardHeader>
        <CardContent>Loading status...</CardContent>
      </Card>
    );
  }

  const isFullyOnboarded = status?.charges_enabled && status?.payouts_enabled;
  const isPartiallyOnboarded = status?.stripe_account_id && !isFullyOnboarded;
  const notOnboarded = !status?.stripe_account_id;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="w-5 h-5" />
          Creator Payments
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium">Payment Status</h3>
            <p className="text-sm text-muted-foreground">Receive 90% of revenue</p>
          </div>
          {isFullyOnboarded && <Badge variant="default" className="bg-green-600">Active</Badge>}
          {!isFullyOnboarded && <Badge variant="outline">Not Enabled</Badge>}
        </div>

        <div className="flex gap-3">
          <EnablePaymentsButton />
          {isFullyOnboarded && (
            <Button variant="outline" onClick={() => openDashboard()} disabled={isDashboardLoading}>
              <ExternalLink className="w-4 h-4 mr-2" />
              View Dashboard
            </Button>
          )}
        </div>

        <div className="pt-4 border-t">
          <h4 className="text-sm font-medium mb-3">Revenue Examples (90/10 split)</h4>
          <div className="space-y-2">
            {[9.99, 19.99, 49.99].map(price => (
              <div key={price} className="flex justify-between text-sm p-2 bg-gray-50 rounded">
                <span>Price: ${price}</span>
                <span className="text-green-600 font-medium">You: ${(price * 0.9).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
```

---

## 🆕 4. Create `src/pages/CreatorOnboarded.tsx`
```typescript
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCreatorStatus } from '@/hooks/useCreator';
import { CheckCircle, Sparkles } from 'lucide-react';
import SEO from '@/components/SEO';

export default function CreatorOnboarded() {
  const navigate = useNavigate();
  const { data: status, refetch } = useCreatorStatus();

  useEffect(() => { refetch(); }, [refetch]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <SEO title="Setup Complete" />
      <Card className="max-w-md w-full text-center p-12">
        <CheckCircle className="w-16 h-16 text-green-600 mx-auto mb-6" />
        <h1 className="text-2xl font-bold">Payment Setup Complete!</h1>
        <p className="text-muted-foreground mt-4">You're ready to start earning.</p>
        <Button className="mt-8 w-full" onClick={() => navigate('/settings/billing')}>
          Go to Settings
        </Button>
      </Card>
    </div>
  );
}
```

---

## 🛠️ 5. Integration Points

### Modify `src/App.tsx`
Add route:
```tsx
import CreatorOnboarded from "./pages/CreatorOnboarded";
// inside <Routes>
<Route path="/creator/onboarded" element={<CreatorOnboarded />} />
```

### Modify `src/pages/settings/Billing.tsx`
Add component:
```tsx
import { CreatorPaymentsSection } from "@/components/creator/CreatorPaymentsSection";
// inside <SplitBarContent value="billing">
<CreatorPaymentsSection />
```

### Modify `src/components/liverooms/CreateLiveRoomDialog.tsx`
Add gating:
```tsx
import { useCreatorStatus } from '@/hooks/useCreator';
import { EnablePaymentsButton } from '@/components/creator/EnablePaymentsButton';

// inside component:
const { data: creatorStatus } = useCreatorStatus();

// inside render (if paid room):
{!creatorStatus?.charges_enabled && <EnablePaymentsButton />}
```
