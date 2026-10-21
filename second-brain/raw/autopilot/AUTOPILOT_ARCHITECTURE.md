# Autopilot System Architecture

## Executive Summary

The Autopilot system is designed to be a scalable, AI-powered proactive action engine that integrates deeply with all Vitana System features (Community, Discover, Wallet, Calendar, Health, etc.). This document outlines the comprehensive architecture for managing thousands of actions with simple implementation and easy management.

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     AI Suggestion Engine                     │
│  (Lovable AI + Context Analysis + User Preferences)         │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  Action Registry System                      │
│  (Templates, Types, Triggers, Integrations)                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
┌─────────────┐ ┌──────────┐ ┌──────────────┐
│  Database   │ │ Execution│ │  Integration │
│   Layer     │ │  Engine  │ │    Layer     │
└─────────────┘ └──────────┘ └──────────────┘
        │             │             │
        └─────────────┼─────────────┘
                      ▼
          ┌──────────────────────┐
          │   Frontend UI Layer  │
          └──────────────────────┘
```

---

## 2. Database Schema

### 2.1 Core Tables

```sql
-- Action Templates (reusable blueprints)
CREATE TABLE autopilot_action_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_code TEXT UNIQUE NOT NULL, -- e.g., "community_post_reminder"
  category TEXT NOT NULL, -- health, community, discover, wallet, calendar
  title_template TEXT NOT NULL, -- "Time to post about {topic}"
  reason_template TEXT NOT NULL,
  default_priority TEXT NOT NULL,
  integration_type TEXT NOT NULL, -- which system to integrate with
  execution_handler TEXT NOT NULL, -- function name to call
  trigger_conditions JSONB NOT NULL, -- when this should be triggered
  required_context JSONB NOT NULL, -- what data is needed
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User-specific action instances
CREATE TABLE autopilot_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  template_id UUID REFERENCES autopilot_action_templates(id),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, executing, completed, skipped, failed
  selected BOOLEAN DEFAULT false,
  
  -- Execution details
  execution_handler TEXT NOT NULL,
  execution_data JSONB DEFAULT '{}', -- data needed for execution
  scheduled_for TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  
  -- Context
  context_snapshot JSONB DEFAULT '{}', -- user state when action was created
  image_url TEXT,
  icon TEXT,
  time_estimate TEXT,
  
  -- Tracking
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ, -- auto-expire old actions
  
  -- Analytics
  viewed BOOLEAN DEFAULT false,
  viewed_at TIMESTAMPTZ,
  interaction_count INT DEFAULT 0
);

-- Action execution logs
CREATE TABLE autopilot_execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES autopilot_actions(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  status TEXT NOT NULL, -- success, failed, partial
  error_message TEXT,
  execution_duration_ms INT,
  result_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User feedback for learning
CREATE TABLE autopilot_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id UUID NOT NULL REFERENCES autopilot_actions(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  template_id UUID REFERENCES autopilot_action_templates(id),
  feedback_type TEXT NOT NULL, -- completed, skipped, dismissed, helpful, not_helpful
  feedback_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger history (for debugging and optimization)
CREATE TABLE autopilot_trigger_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  template_code TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- scheduled, event, context_change
  trigger_data JSONB DEFAULT '{}',
  action_created BOOLEAN DEFAULT false,
  action_id UUID REFERENCES autopilot_actions(id),
  reason_skipped TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 2.2 Indexes for Performance

```sql
-- User's pending actions (most common query)
CREATE INDEX idx_autopilot_actions_user_status ON autopilot_actions(user_id, status) WHERE status = 'pending';

-- Template lookups
CREATE INDEX idx_autopilot_actions_template ON autopilot_actions(template_id);

-- Category filtering
CREATE INDEX idx_autopilot_actions_category ON autopilot_actions(user_id, category, status);

-- Scheduled actions
CREATE INDEX idx_autopilot_actions_scheduled ON autopilot_actions(scheduled_for) WHERE status = 'pending';

-- Expired actions cleanup
CREATE INDEX idx_autopilot_actions_expires ON autopilot_actions(expires_at) WHERE status = 'pending';
```

---

## 3. Action Registry System

### 3.1 Template Structure

Each action template defines:
- **Trigger conditions**: When to create the action
- **Context requirements**: What data is needed
- **Execution handler**: Which function executes it
- **Integration points**: Which Vitana features it connects to

Example template:

```typescript
{
  template_code: "community_weekly_post",
  category: "community",
  title_template: "Share your {activity} progress this week",
  reason_template: "Your community loves updates! You've {metric} this week.",
  default_priority: "medium",
  integration_type: "community_posts",
  execution_handler: "create_community_post",
  trigger_conditions: {
    type: "scheduled",
    schedule: "0 9 * * 1", // Every Monday at 9am
    requires: ["activity_data", "community_membership"]
  },
  required_context: {
    activity_type: "string",
    metric_value: "number",
    user_community_ids: "array"
  },
  metadata: {
    icon: "Users",
    estimated_time: "5 min",
    reward_vitana: 50
  }
}
```

### 3.2 Template Categories

Organize templates by feature area:

```
/templates
  /health
    - daily_health_check.ts
    - supplement_reminder.ts
    - wellness_milestone.ts
  /community
    - weekly_post.ts
    - reply_to_thread.ts
    - welcome_new_member.ts
  /discover
    - content_recommendation.ts
    - learning_goal.ts
    - explore_topic.ts
  /wallet
    - send_currency.ts
    - celebrate_earnings.ts
    - exchange_reminder.ts
  /calendar
    - schedule_event.ts
    - event_reminder.ts
    - reschedule_suggestion.ts
  /memory
    - capture_moment.ts
    - reflect_on_entry.ts
    - anniversary_reminder.ts
```

---

## 4. Execution Engine

### 4.1 Edge Function Architecture

```typescript
// supabase/functions/autopilot-execute/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Handler registry
const handlers = {
  create_community_post: async (data, context) => { /* ... */ },
  schedule_event: async (data, context) => { /* ... */ },
  send_vitana: async (data, context) => { /* ... */ },
  // ... 100+ handlers
}

serve(async (req) => {
  const { action_id, user_id, handler, execution_data } = await req.json()
  
  // Get handler function
  const handlerFn = handlers[handler]
  if (!handlerFn) {
    return new Response(JSON.stringify({ error: "Handler not found" }), { status: 400 })
  }
  
  // Execute with error handling and logging
  const startTime = Date.now()
  try {
    const result = await handlerFn(execution_data, { user_id, action_id })
    const duration = Date.now() - startTime
    
    // Log success
    await supabase.from('autopilot_execution_logs').insert({
      action_id,
      user_id,
      status: 'success',
      execution_duration_ms: duration,
      result_data: result
    })
    
    // Update action status
    await supabase.from('autopilot_actions').update({
      status: 'completed',
      executed_at: new Date().toISOString()
    }).eq('id', action_id)
    
    return new Response(JSON.stringify({ success: true, result }), { status: 200 })
  } catch (error) {
    // Log failure
    await supabase.from('autopilot_execution_logs').insert({
      action_id,
      user_id,
      status: 'failed',
      error_message: error.message,
      execution_duration_ms: Date.now() - startTime
    })
    
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 })
  }
})
```

### 4.2 Handler Implementation Pattern

Each handler follows this pattern:

```typescript
interface HandlerContext {
  user_id: string
  action_id: string
  supabase: SupabaseClient
}

interface ExecutionResult {
  success: boolean
  data?: any
  error?: string
}

async function create_community_post(
  data: { content: string; community_id: string; visibility: string },
  context: HandlerContext
): Promise<ExecutionResult> {
  // 1. Validate input
  if (!data.content || !data.community_id) {
    throw new Error("Missing required fields")
  }
  
  // 2. Execute integration
  const { data: post, error } = await context.supabase
    .from('community_posts')
    .insert({
      user_id: context.user_id,
      community_id: data.community_id,
      content: data.content,
      visibility: data.visibility,
      source: 'autopilot'
    })
    .select()
    .single()
  
  if (error) throw error
  
  // 3. Award rewards
  await awardVitana(context.user_id, 50, 'autopilot_post')
  
  // 4. Return result
  return {
    success: true,
    data: { post_id: post.id }
  }
}
```

---

## 5. AI Suggestion Engine

### 5.1 Edge Function for Generating Actions

```typescript
// supabase/functions/autopilot-suggest/index.ts

serve(async (req) => {
  const { user_id } = await req.json()
  
  // 1. Gather user context
  const context = await gatherUserContext(user_id)
  
  // 2. Get applicable templates
  const templates = await getApplicableTemplates(user_id, context)
  
  // 3. Use AI to generate personalized suggestions
  const suggestions = await generateAISuggestions(templates, context)
  
  // 4. Create action instances
  const actions = await createActionInstances(user_id, suggestions)
  
  return new Response(JSON.stringify({ actions }), { status: 200 })
})

async function gatherUserContext(user_id: string) {
  // Fetch all relevant user data
  const [profile, preferences, recentActivity, wallet, calendar, health] = await Promise.all([
    supabase.from('profiles').select('*').eq('user_id', user_id).single(),
    supabase.from('user_preferences').select('*').eq('user_id', user_id).single(),
    supabase.from('diary_entries').select('*').eq('user_id', user_id).order('created_at', { ascending: false }).limit(10),
    supabase.from('user_wallets').select('*').eq('user_id', user_id),
    supabase.from('calendar_events').select('*').eq('user_id', user_id).gte('start_time', new Date().toISOString()),
    // ... more context
  ])
  
  return {
    profile: profile.data,
    preferences: preferences.data,
    recent_activity: recentActivity.data,
    wallet: wallet.data,
    calendar: calendar.data,
    health: health.data,
    timestamp: new Date().toISOString()
  }
}

async function generateAISuggestions(templates, context) {
  const systemPrompt = `You are the Vitana AI Assistant. Generate personalized autopilot actions based on user context.
  
User Context:
${JSON.stringify(context, null, 2)}

Available Templates:
${templates.map(t => `- ${t.template_code}: ${t.title_template}`).join('\n')}

Rules:
- Only suggest actions that are highly relevant and timely
- Consider user preferences and quiet hours
- Max ${context.preferences.autopilot_max_actions_per_day} actions per day
- Prioritize based on user's current goals and recent activity
- Include specific, actionable details

Return JSON array of suggested actions with:
{
  "template_code": "string",
  "title": "personalized title",
  "reason": "why now",
  "priority": "high|medium|low",
  "execution_data": { specific data needed },
  "time_estimate": "X min"
}
`

  const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('LOVABLE_API_KEY')}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate autopilot actions for this user.' }
      ],
      tools: [{
        type: "function",
        function: {
          name: "suggest_actions",
          description: "Return personalized autopilot action suggestions",
          parameters: {
            type: "object",
            properties: {
              suggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    template_code: { type: "string" },
                    title: { type: "string" },
                    reason: { type: "string" },
                    priority: { type: "string", enum: ["high", "medium", "low"] },
                    execution_data: { type: "object" },
                    time_estimate: { type: "string" }
                  },
                  required: ["template_code", "title", "reason", "priority", "execution_data"]
                }
              }
            },
            required: ["suggestions"]
          }
        }
      }],
      tool_choice: { type: "function", function: { name: "suggest_actions" } }
    })
  })
  
  const data = await response.json()
  return JSON.parse(data.choices[0].message.tool_calls[0].function.arguments).suggestions
}
```

### 5.2 Scheduled Trigger (Cron Job)

```sql
-- Run every hour to generate new actions for active users
SELECT cron.schedule(
  'autopilot-hourly-suggestions',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://[project-ref].supabase.co/functions/v1/autopilot-suggest',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer [ANON_KEY]"}'::jsonb,
    body := jsonb_build_object('trigger_type', 'scheduled')
  ) as request_id;
  $$
);
```

---

## 6. Frontend Integration

### 6.1 Updated Hook Architecture

```typescript
// src/hooks/use-autopilot.ts
export function useAutopilot() {
  const { preferences } = useUserPreferences()
  
  // Real-time subscription to user's actions
  const { data: actions, isLoading } = useQuery({
    queryKey: ['autopilot-actions'],
    queryFn: async () => {
      const { data } = await supabase
        .from('autopilot_actions')
        .select('*')
        .eq('user_id', (await supabase.auth.getUser()).data.user?.id)
        .eq('status', 'pending')
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
      
      return data || []
    }
  })
  
  // Subscribe to real-time updates
  useEffect(() => {
    const channel = supabase
      .channel('autopilot-actions')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'autopilot_actions',
          filter: `user_id=eq.${user?.id}`
        },
        () => {
          queryClient.invalidateQueries(['autopilot-actions'])
        }
      )
      .subscribe()
    
    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id])
  
  // Execute action
  const executeAction = useMutation({
    mutationFn: async (actionId: string) => {
      const { data, error } = await supabase.functions.invoke('autopilot-execute', {
        body: { action_id: actionId }
      })
      if (error) throw error
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['autopilot-actions'])
      toast({ title: "Action completed!" })
    }
  })
  
  return {
    actions,
    isLoading,
    executeAction: executeAction.mutate,
    // ... more methods
  }
}
```

---

## 7. Development Roadmap

### Phase 1: Foundation (Week 1-2)
- ✅ Basic types and UI (already done)
- [ ] Database schema implementation
- [ ] Basic execution engine
- [ ] 10 core templates (2 per category)

### Phase 2: AI Integration (Week 3-4)
- [ ] AI suggestion engine
- [ ] Context gathering system
- [ ] Intelligent prioritization
- [ ] User feedback loop

### Phase 3: Scaling (Week 5-6)
- [ ] Template management UI
- [ ] 50+ action templates
- [ ] Execution handler registry
- [ ] Analytics dashboard

### Phase 4: Intelligence (Week 7-8)
- [ ] Learning from user behavior
- [ ] Predictive action timing
- [ ] Cross-feature optimization
- [ ] Success rate optimization

---

## 8. Integration Points

### 8.1 Community Integration
```typescript
handlers.create_community_post = async (data, ctx) => {
  // Post to community
  // Award Vitana
  // Update user stats
}

handlers.reply_to_thread = async (data, ctx) => {
  // Reply to specific thread
  // Notify original poster
  // Award engagement points
}
```

### 8.2 Wallet Integration
```typescript
handlers.send_vitana = async (data, ctx) => {
  // Execute wallet transfer
  // Log transaction
  // Notify recipient
}

handlers.suggest_exchange = async (data, ctx) => {
  // Suggest optimal exchange based on rates
  // Pre-fill exchange form
}
```

### 8.3 Calendar Integration
```typescript
handlers.schedule_event = async (data, ctx) => {
  // Create calendar event
  // Send invites
  // Set reminders
}
```

### 8.4 Health Integration
```typescript
handlers.log_supplement = async (data, ctx) => {
  // Log supplement intake
  // Update streaks
  // Award health points
}
```

---

## 9. Management UI

### 9.1 Admin Template Manager
- Create/edit/delete templates
- Test templates with sample data
- View template performance metrics
- Enable/disable templates globally

### 9.2 User Action Dashboard
- View all pending actions
- Action history and patterns
- Performance metrics
- Customize action preferences

---

## 10. Scalability Considerations

### 10.1 Performance
- Database indexes on all query paths
- Edge function caching
- Batch action creation
- Lazy loading of action details

### 10.2 Cost Optimization
- AI calls only when needed (not per action)
- Batch processing
- Smart scheduling
- Template reuse

### 10.3 Monitoring
- Execution success rates
- User engagement rates
- Template performance
- System health metrics

---

## 11. Next Steps

1. **Implement database schema** - Create all tables
2. **Build execution engine** - Core edge function + 10 handlers
3. **Create template system** - Registry + 10 templates
4. **Integrate AI suggestion** - Lovable AI powered suggestions
5. **Update frontend** - Connect to real data
6. **Add analytics** - Track and optimize

---

## Conclusion

This architecture provides:
- ✅ **Scalability**: Handles thousands of actions efficiently
- ✅ **Maintainability**: Clear separation of concerns
- ✅ **Extensibility**: Easy to add new templates and handlers
- ✅ **Integration**: Deep connection with all Vitana features
- ✅ **Intelligence**: AI-powered, context-aware suggestions
- ✅ **Reliability**: Comprehensive logging and error handling

The system grows with your needs while maintaining simplicity for developers and users.
