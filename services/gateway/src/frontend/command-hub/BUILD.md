# Command Hub V2 Build Instructions

## Install Dependencies
```bash
npm install
```

## Bundle React Application
This command bundles `app.jsx` and all its dependencies (React, ReactDOM) into a single `app.js` file, suitable for CSP-compliant environments (no CDN).

```bash
npx esbuild app.jsx --bundle --outfile=app.js --define:process.env.NODE_ENV=\"production\"
```

## Deployment
(Executed by Claude/Operator)
```bash
./scripts/deploy/deploy-service.sh gateway services/gateway
```

## Verification
1. Access `$GATEWAY_URL/command-hub`
2. Verify Sidebar navigation works
3. Verify "Tasks" tab loads the Task Board
4. Verify Modals open/close
5. Check console for errors
