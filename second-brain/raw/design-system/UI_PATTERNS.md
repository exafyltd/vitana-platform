# UI Patterns Documentation

## Community Header Pattern (MANDATORY)

**Pattern ID**: `community-header-3-card`
**Status**: Required for ALL Community pages
**Last Updated**: 2025-01-27

### Structure Overview
All Community pages MUST use the exact 3-card header layout:

```tsx
<div className="flex flex-col lg:flex-row gap-4 mb-8">
  {/* Left Card - Welcome Message (flex-1) */}
  {/* Middle Card - Autopilot Widget (w-32) */}
  {/* Right Card - Vitana Index (w-32) */}
</div>
```

### Left Card - Welcome Message
- **Width**: `flex-1`
- **Purpose**: Page-specific welcome message
- **Classes**: `bg-white/80 backdrop-blur-sm rounded-2xl p-8 shadow-lg border border-white/20`

### Middle Card - Autopilot Widget
- **Width**: `w-32` 
- **Purpose**: Shows pending autopilot actions with badge counter
- **Required imports**: `useAutopilot`, `Badge`
- **Features**: Click opens popup, hover shows preview
- **Classes**: Same as left card + `cursor-pointer group transition-all duration-300 hover:shadow-xl relative`

### Right Card - Vitana Index 
- **Width**: `w-32`
- **Purpose**: Shows circular Vitana score (742) and navigates to index page
- **Required imports**: `useNavigate`
- **Classes**: Same as middle card
- **Content**: Circular gradient background with large "742" text

### Required Code Pattern

```tsx
// Required imports
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { useAutopilot } from "@/hooks/use-autopilot";
import { Plane } from "lucide-react";

// In component
const navigate = useNavigate();
const { pendingCount, getLatestActions } = useAutopilot();
const [autopilotOpen, setAutopilotOpen] = useState(false);
const [showPreview, setShowPreview] = useState(false);
const latestActions = getLatestActions(2);

// Header JSX (EXACT pattern)
<div className="flex flex-col lg:flex-row gap-4 mb-8">
  {/* Welcome Message */}
  <div className="flex-1 bg-white/80 backdrop-blur-sm rounded-2xl p-8 shadow-lg border border-white/20">
    <div>
      <h1 className="text-3xl font-bold text-foreground mb-2">[Page Title] ✨</h1>
      <p className="text-muted-foreground">[Page Description]</p>
    </div>
  </div>
  
  {/* Autopilot Card */}
  <div 
    className="w-32 bg-white/80 backdrop-blur-sm rounded-2xl p-6 shadow-lg border border-white/20 cursor-pointer group transition-all duration-300 hover:shadow-xl relative"
    onClick={() => setAutopilotOpen(true)}
    onMouseEnter={() => setShowPreview(true)}
    onMouseLeave={() => setShowPreview(false)}
  >
    {pendingCount > 0 && (
      <Badge 
        variant="destructive" 
        className="absolute -top-2 -right-2 w-6 h-6 rounded-full p-0 flex items-center justify-center text-xs animate-pulse z-10"
      >
        {pendingCount}
      </Badge>
    )}
    <div className="flex flex-col items-center justify-center h-full space-y-3">
      <div>
        <Plane className="w-10 h-10 text-red-400 transform rotate-0" />
      </div>
      <span className="text-sm font-medium text-red-400">Autopilot</span>
    </div>
    
    {/* Hover Preview */}
    {showPreview && pendingCount > 0 && (
      <div className="absolute top-full left-0 mt-2 w-64 bg-white/95 backdrop-blur-sm border border-white/20 rounded-lg shadow-xl p-3 z-10">
        <div className="text-xs font-medium text-muted-foreground mb-2">Latest Actions:</div>
        {latestActions.map((action, index) => (
          <div key={action.id} className="flex items-center space-x-2 text-xs py-1">
            <span>{action.icon}</span>
            <span className="truncate">{action.title}</span>
          </div>
        ))}
        {pendingCount > 2 && (
          <div className="text-xs text-muted-foreground pt-1 border-t mt-1">
            +{pendingCount - 2} more actions
          </div>
        )}
      </div>
    )}
  </div>
  
  {/* Vitana Index Card */}
  <div 
    className="w-32 bg-white/80 backdrop-blur-sm rounded-2xl p-6 shadow-lg border border-white/20 cursor-pointer group transition-all duration-300 hover:shadow-xl"
    onClick={() => navigate('/health-tracker/vitana-index')}
  >
    <div className="flex items-center justify-center h-full">
      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-400/30 to-blue-500/30 flex items-center justify-center shadow-lg shadow-green-500/20 group-hover:shadow-green-500/40 transition-all duration-300">
        <span className="text-xl font-bold text-green-600">742</span>
      </div>
    </div>
  </div>
</div>
```

## Validation Rules

### NEVER DO:
❌ Single card headers on Community pages
❌ Different spacing or styling
❌ Missing autopilot functionality
❌ Missing Vitana Index navigation
❌ Custom button placements in header area

### ALWAYS DO:
✅ Use exact 3-card pattern
✅ Import all required dependencies
✅ Test autopilot popup functionality
✅ Test Vitana Index navigation
✅ Match exact styling classes

## Pattern Enforcement

This pattern is enforced through:
1. Shared components (coming soon)
2. TypeScript interfaces
3. Code review requirements
4. Automated testing

## Examples

### ✅ CORRECT Implementation
- `src/pages/Community.tsx` (lines 105-166)
- `src/pages/community/LiveInteraction.tsx`

### ❌ INCORRECT Implementation  
- Any single-card header
- Missing autopilot or Vitana cards
- Custom button placements in header

## Breaking Changes
Any deviation from this pattern is considered a breaking change and requires approval from the design system team.