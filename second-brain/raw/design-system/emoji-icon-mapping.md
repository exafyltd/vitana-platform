# Emoji Icon Mapping for SplitBar Navigation

> **Version:** 1.0  
> **Last Updated:** January 2025  
> **Purpose:** Comprehensive catalog of all emoji icons used in SplitBar navigation components across the Vitana platform

---

## Table of Contents

1. [Overview](#overview)
2. [Icon Selection Guidelines](#icon-selection-guidelines)
3. [Settings Section](#settings-section)
4. [Dev Hub Section](#dev-hub-section)
5. [Memory Section](#memory-section)
6. [Main Application Pages](#main-application-pages)
7. [Quick Reference Table](#quick-reference-table)

---

## Overview

This document provides a comprehensive catalog of all emoji icons used in SplitBar navigation components throughout the Vitana platform. Consistent use of these icons improves user experience, visual recognition, and navigation efficiency.

### Why Emoji Icons?

- **Visual Recognition**: Emoji icons provide instant visual cues
- **Accessibility**: Universal symbols that transcend language barriers
- **Consistency**: Standardized icons across the entire platform
- **User Experience**: Friendly, approachable interface design

---

## Icon Selection Guidelines

When choosing emoji icons for new SplitBar tabs:

### 1. **Clarity & Relevance**
- Icon must clearly represent the tab's content
- Avoid ambiguous or multiple-meaning emojis
- Choose the most intuitive representation

### 2. **Visual Distinction**
- Ensure icons are visually distinct within the same SplitBar
- Avoid using similar-looking emojis in adjacent tabs
- Use different colors/shapes when possible

### 3. **Professional Tone**
- Maintain professional appearance for business features
- Use playful icons appropriately for community/wellness features
- Balance friendliness with credibility

### 4. **Consistency**
- Check existing usage before introducing new icons
- Reuse icons for similar concepts across different pages
- Follow established patterns (e.g., 🏠 for Overview, ⚙️ for Settings)

### 5. **Accessibility**
- Icons should supplement, not replace, text labels
- Ensure icon + text combination is screen-reader friendly
- Test on multiple devices/platforms for emoji rendering

### 6. **Navigation Hierarchy** ⭐ NEW
- **Page-Level Navigation (SplitBar/Tabs)**: Use emoji icons for visual consistency
- **Modal/Popup Navigation**: Use Lucide icons to distinguish from page-level navigation
- **Rationale**: Creates clear visual hierarchy between primary navigation and contextual actions

**Files that retain Lucide icons in modal/popup contexts:**
- `AddToAIFeedPopup.tsx`
- `CreateContentPopup.tsx`
- `CreatePackagePopup.tsx`
- `ManageMyActionsPopup.tsx`

---

## Settings Section

### Billing (`/settings/billing`)

| Icon | Label | Purpose |
|------|-------|---------|
| 💳 | Billing | Payment methods, subscription details, billing history |
| 🏆 | Rewards & Achievements | Points, rewards, achievements tracking |

**File:** `src/pages/settings/Billing.tsx`

---

### Connected Apps (`/settings/connected-apps`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🔌 | Connected Apps | Currently connected applications and integrations |
| ✨ | Available Integrations | Browse and connect new integrations |
| 🔄 | Data Sync | Sync settings and status monitoring |

**File:** `src/pages/settings/ConnectedApps.tsx`

---

### Preferences (`/settings/preferences`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🎨 | Appearance | Theme settings, colors, visual preferences |
| 🌐 | Language & Region | Localization, language, regional settings |
| ♿ | Accessibility | Accessibility features and options |

**File:** `src/pages/settings/Preferences.tsx`

---

### Privacy (`/settings/privacy`)

| Icon | Label | Purpose |
|------|-------|---------|
| 👁️ | Profile Visibility | Control who can see your profile |
| 📊 | Data Sharing | Manage data sharing preferences |
| 🔒 | Security | Security settings, passwords, 2FA |

**File:** `src/pages/settings/Privacy.tsx`

---

### Support (`/settings/support`)

| Icon | Label | Purpose |
|------|-------|---------|
| 💬 | Contact Support | Live chat, email, call back options |
| 📚 | Knowledge Base | Help articles and documentation |
| 👥 | Community Help | Community forums and peer support |

**File:** `src/pages/settings/Support.tsx`

---

## Dev Hub Section

### Dev Settings

#### Authentication (`/dev/settings/auth`)

| Icon | Label | Purpose |
|------|-------|---------|
| ⚙️ | Supabase Config | Supabase authentication configuration |
| 🔑 | Auth Providers | OAuth and authentication providers |
| 🎫 | JWT Settings | JWT token configuration and validation |

**File:** `src/pages/dev/settings/Auth.tsx`

---

#### Feature Flags (`/dev/settings/flags`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🚩 | Flag List | Browse all feature flags |
| 🔘 | Flag Status | View flag status across environments |
| 📜 | Flag History | Track flag changes and history |

**File:** `src/pages/dev/settings/Flags.tsx`

---

#### Tenant Management (`/dev/settings/tenants`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🏢 | Tenant List | View all tenants (System, Maxina, Earthlinks, AlKalma) |
| 👤 | Tenant Users | Manage tenant users and access control |
| ⚙️ | Tenant Configs | Configure tenant-specific settings |

**File:** `src/pages/dev/settings/Tenants.tsx`

---

### Dev Dashboard

#### Command Hub (`/dev/dashboard`)

| Icon | Label | Purpose |
|------|-------|---------|
| 📊 | Overview | Dashboard overview and metrics |
| 🤖 | AI Feed | AI-generated insights and updates |
| 🔔 | Alerts | System alerts and notifications |
| 💚 | System Health | System health monitoring |

**File:** `src/pages/dev/DevDashboard.tsx`

---

### Dev Tools

#### Agents (`/dev/agents`)

| Icon | Label | Purpose |
|------|-------|---------|
| 📋 | Planner | Agent planning and orchestration |
| ⚙️ | Worker | Worker agent management |
| ✅ | Validator | Validation agent configuration |
| 🧪 | QA/Test | Quality assurance and testing agents |
| 👥 | Crew Template | Multi-agent crew templates |

**File:** `src/pages/dev/DevAgents.tsx`

---

#### CI/CD (`/dev/cicd`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🔄 | Workflows | CI/CD workflow management |
| ▶️ | Runs | Workflow runs and execution history |
| 📦 | Artifacts | Build artifacts and outputs |
| 🌐 | Env Matrix | Environment matrix configuration |

**File:** `src/pages/dev/DevCICD.tsx`

---

#### Command Center (`/dev/command`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🎮 | Command Center | Central command interface |
| 📋 | Open Tasks | View and manage open tasks |

**File:** `src/pages/dev/DevCommand.tsx`

---

#### Gateway (`/dev/gateway`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🔌 | Endpoints | API endpoint management |
| 📡 | Requests | Request monitoring and logs |
| 📱 | Mobile Links | Mobile deep link configuration |
| 🪝 | Webhooks | Webhook management and testing |

**File:** `src/pages/dev/DevGateway.tsx`

---

#### Oasis Event Store (`/dev/oasis`)

| Icon | Label | Purpose |
|------|-------|---------|
| ⚡ | Events | Event stream and monitoring |
| 🔄 | State | State management and snapshots |
| 📒 | Ledger | Event ledger and audit trail |
| 📜 | Policies | Event policies and rules |

**File:** `src/pages/dev/DevOasis.tsx`

---

#### Observability (`/dev/observability`)

| Icon | Label | Purpose |
|------|-------|---------|
| 📝 | Logs | Application logs and monitoring |
| 🔍 | Traces | Distributed tracing |
| 📈 | Metrics | Performance metrics and analytics |
| 💰 | Costs | Cost analysis and budgeting |

**File:** `src/pages/dev/DevObservability.tsx`

---

#### Pipelines (`/dev/pipelines`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🔨 | Builds | Build pipeline management |
| 🧪 | Tests | Test execution and results |
| 🐤 | Canary | Canary deployment tracking |
| ⏮️ | Rollbacks | Rollback management |

**File:** `src/pages/dev/DevPipelines.tsx`

---

#### Dev Settings (`/dev/settings`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🌍 | Environment | Environment configuration |
| 🔐 | Auth | Authentication settings |
| 🚩 | Feature Flags | Feature flag overview |
| 🏢 | Tenants | Tenant management overview |

**File:** `src/pages/dev/DevSettings.tsx`

---

#### VTID Management (`/dev/vtid`)

| Icon | Label | Purpose |
|------|-------|---------|
| 📚 | Registry | VTID registry and lookup |
| 🎫 | Issue | Issue and assign VTIDs |
| 📊 | Analytics | VTID analytics and insights |
| 🔍 | Search | Search VTIDs and metadata |

**File:** `src/pages/dev/DevVTID.tsx`

---

## Memory Section

### Wellness Diary (`/memory/diary`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🎤 | Voice | Voice diary entries and recordings |
| 📸 | Photos | Photo diary entries and gallery |
| ✍️ | Text | Text-based diary entries |

**File:** `src/pages/memory/Diary.tsx`

---

### AI Memory Recall (`/memory/recall`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🔍 | Search Results | Memory search and results |
| 🧠 | AI Insights | AI-generated insights from memories |
| ⚡ | Quick Recall | Quick access to recent memories |

**File:** `src/pages/memory/Recall.tsx`

---

## Main Application Pages

### Wallet (`/wallet`)

| Icon | Label | Purpose |
|------|-------|---------|
| 💰 | Balance Overview | Account balances and overview |
| 📊 | Recent Activity | Transaction history and activity |
| ⚡ | Smart Actions | Quick actions and recommendations |

**File:** `src/pages/Wallet.tsx`

---

### Community (`/community`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🏠 | Overview | Community overview and highlights |
| 🏆 | Rankings | Leaderboards and rankings |
| ⭐ | Spotlight | Featured content and creators |

**File:** `src/pages/Community.tsx`

---

### Discover (`/discover`)

| Icon | Label | Purpose |
|------|-------|---------|
| 💡 | Suggested for You | AI-powered personalized recommendations |
| 📂 | Categories | Browse by product/service categories |
| 💰 | Share & Earn | Affiliate sharing and earnings |

**File:** `src/pages/Discover.tsx`

---

### Media Hub (`/community/media-hub`)

| Icon | Label | Purpose |
|------|-------|---------|
| 📹 | Shorts | Short-form video content |
| 🎵 | Music | Music streaming and playlists |
| 🎙️ | Podcasts | Podcast episodes and shows |

**File:** `src/pages/community/MediaHub.tsx`

---

### Messages (`/messages`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🌍 | Global Community | Global community messages |
| 🏢 | Professional Network | Professional network messages |

**File:** `src/pages/Messages.tsx`

---

### My Business (`/community/my-business`)

| Icon | Label | Purpose |
|------|-------|---------|
| 💼 | Management | Business service management |
| 👥 | Referrals | Referral program and tracking |
| 📊 | Analytics | Business analytics and insights |
| 👤 | Clients | Client management |

**File:** `src/pages/community/MyBusinessRenamed.tsx`

---

### Matches (`/home/matches`)

| Icon | Label | Purpose |
|------|-------|---------|
| 👥 | People | Match with individuals |
| 💬 | Groups | Match with groups and communities |
| ✅ | Coaches | Find compatible coaches |
| 📅 | Events | Discover matching events |
| 🎯 | Analysis | Compatibility analysis and insights |

**File:** `src/pages/home/Matches.tsx`

---

### Live Room Directory (`/community/live-room-directory`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🔴 | Live now | Currently live rooms |
| 📅 | Scheduled | Upcoming scheduled rooms |
| 📋 | All rooms | All available rooms |

**File:** `src/components/community/LiveRoomDirectory.tsx`

---

### Orders (`/discover/orders`)

| Icon | Label | Purpose |
|------|-------|---------|
| ⏰ | Active Orders | Currently active orders |
| ✅ | Order History | Completed order history |

**File:** `src/pages/discover/Orders.tsx`

---

### Timeline (`/memory/timeline`)

| Icon | Label | Purpose |
|------|-------|---------|
| 📋 | All | All activity timeline |
| 📊 | By Category | Activity organized by category |

**File:** `src/pages/memory/Timeline.tsx`

---

### Search (`/search`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🔍 | All | All search results |
| 👥 | People | Search people |
| 💬 | Groups | Search groups |
| 🎬 | Content | Search content |
| ❤️ | Health | Search health resources |

**File:** `src/pages/Search.tsx`

---

### Messages Section

#### Archived (`/messages/archived`)

| Icon | Label | Purpose |
|------|-------|---------|
| 📂 | All Archives | View all archived messages |
| ⏰ | Recently Archived | Messages archived recently |
| 📦 | By Category | Organized by category |
| ⚙️ | Settings | Archive settings |

**File:** `src/pages/messages/Archived.tsx`

---

#### Reminder (`/messages/reminder`)

| Icon | Label | Purpose |
|------|-------|---------|
| ⏰ | Unanswered | Messages awaiting response |
| 💬 | Recent Replies | Recently replied messages |
| ⚠️ | Follow Up Needed | Messages requiring follow-up |
| 📊 | Response Stats | Response statistics |

**File:** `src/pages/messages/Reminder.tsx`

---

#### Inspiration (`/messages/inspiration`)

| Icon | Label | Purpose |
|------|-------|---------|
| 💡 | Templates | Pre-made message templates |
| ❤️ | My Favorites | Saved favorite messages |
| ⏰ | Recently Used | Recently used templates |
| ✏️ | Custom Messages | Custom message creation |

**File:** `src/pages/messages/Inspiration.tsx`

---

### Health Section

#### My Biology (`/health/my-biology`)

| Icon | Label | Purpose |
|------|-------|---------|
| 🧪 | My Medical | Medical biomarkers and lab results |
| 🧬 | My Omics | Genomics, metabolomics, and omics data |
| 💊 | My Supplements | Supplement tracking and management |

**File:** `src/pages/health/MyBiology.tsx`

---

| Icon | Label | Purpose |
|------|-------|---------|
| 💡 | Templates | Pre-written message templates |
| ❤️ | My Favorites | Saved favorite templates |
| ⏰ | Recently Used | Recently used templates |
| ✏️ | Custom Messages | Custom created messages |

**File:** `src/pages/messages/Inspiration.tsx`

---

## Quick Reference Table

### Common Icon Patterns

| Icon | Common Use Cases | Examples |
|------|------------------|----------|
| 🏠 | Home, Overview, Dashboard | Community Overview |
| ⚙️ | Settings, Configuration | Supabase Config, Worker Agent, Tenant Configs |
| 📊 | Analytics, Data, Activity | Recent Activity, Analytics, Metrics |
| 🔍 | Search, Traces, Lookup | Search Results, Traces, VTID Search |
| 💰 | Money, Costs, Earnings | Balance Overview, Costs, Share & Earn |
| 📝 | Logs, Text, Documentation | Logs, Text Diary |
| 🔔 | Alerts, Notifications | Alerts |
| 🔐 | Security, Auth, Encryption | Security, Auth Providers |
| 🏆 | Achievements, Rankings, Success | Rewards & Achievements, Rankings |
| 👥 | Users, Community, Groups | Community Help, Crew Template, Tenant Users |
| 📚 | Knowledge, Documentation, Registry | Knowledge Base, Registry |
| 🚩 | Flags, Markers | Feature Flags, Flag List |
| 🔄 | Sync, Refresh, State, Workflows | Data Sync, State, Workflows |
| ⚡ | Quick, Fast, Events | Quick Recall, Smart Actions, Events |
| 🎨 | Design, Appearance, Visual | Appearance |
| 🌐 | Global, Network, Environment | Language & Region, Env Matrix, Environment |
| 📱 | Mobile, Devices | Mobile Links |
| 🔌 | Connections, Integrations | Connected Apps, Endpoints |

---

## Implementation Guidelines

### Code Example

```tsx
import { SplitBar, SplitBarContent, SplitBarList, SplitBarTrigger } from "@/components/ui/split-bar";

<SplitBar value={activeTab} onValueChange={setActiveTab}>
  <SplitBarList>
    <SplitBarTrigger value="overview">🏠 Overview</SplitBarTrigger>
    <SplitBarTrigger value="settings">⚙️ Settings</SplitBarTrigger>
    <SplitBarTrigger value="analytics">📊 Analytics</SplitBarTrigger>
  </SplitBarList>

  <SplitBarContent value="overview">
    {/* Overview content */}
  </SplitBarContent>

  <SplitBarContent value="settings">
    {/* Settings content */}
  </SplitBarContent>

  <SplitBarContent value="analytics">
    {/* Analytics content */}
  </SplitBarContent>
</SplitBar>
```

### Best Practices

1. **Always include the emoji before the text label**
   - ✅ `<SplitBarTrigger value="overview">🏠 Overview</SplitBarTrigger>`
   - ❌ `<SplitBarTrigger value="overview">Overview 🏠</SplitBarTrigger>`

2. **Use a single space between emoji and text**
   - ✅ `"🏠 Overview"`
   - ❌ `"🏠  Overview"` (double space)
   - ❌ `"🏠Overview"` (no space)

3. **Maintain consistency across similar features**
   - If using 📊 for "Analytics" in one section, use it for "Analytics" elsewhere

4. **Test emoji rendering across devices**
   - Some emojis may render differently on different platforms
   - Verify on iOS, Android, Windows, macOS

5. **Document new icons added**
   - Update this file when adding new SplitBar navigation
   - Follow the established format and guidelines

---

## Version History

| Version | Date | Changes | Updated By |
|---------|------|---------|------------|
| 1.0 | January 2025 | Initial documentation with complete emoji catalog | Lovable AI |

---

## Contributing

When adding new SplitBar navigation:

1. **Choose appropriate emoji icon** following the guidelines above
2. **Add entry to this documentation** in the correct section
3. **Update the Quick Reference Table** if introducing new icon patterns
4. **Test across devices** to ensure proper rendering
5. **Commit changes** with clear description of additions

---

## Related Documentation

- [Component Library - SplitBar](../components/split-bar.md)
- [Design System - Colors](./colors.md)
- [Design System - Typography](./typography.md)
- [Accessibility Guidelines](./accessibility.md)

---

**Questions or Suggestions?**  
Contact the Design Team or submit a PR with proposed changes.
