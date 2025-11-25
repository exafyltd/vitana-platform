## 🎯 VTID Reference

**VTID:** `DEV-XXXX-NNNN` _(replace with actual VTID)_

**Layer:** _(e.g., CICDL, APIL, AGTL, UIUX)_

**Priority:** _(P0, P1, P2, P3)_

---

## 📋 Summary

_Brief description of what this PR accomplishes._

---

## ✅ Changes

- [ ] Item 1
- [ ] Item 2
- [ ] Item 3

---

## 🧪 Testing

_How was this tested?_

- [ ] Manual testing completed
- [ ] Automated tests added/updated
- [ ] Verified in staging/dev environment

---

## 📝 Phase 2B Naming Compliance Checklist

**All items must be checked before merging:**

### GitHub Actions
- [ ] All workflow files use **UPPERCASE** names (e.g., `DEPLOY-GATEWAY.yml`, not `deploy-gateway.yml`)
- [ ] All workflows include `run-name` with VTID
- [ ] No lowercase workflow names present

### File Names
- [ ] All new files follow **kebab-case** convention (e.g., `my-service.ts`, not `myService.ts` or `my_service.ts`)
- [ ] Directory names use **kebab-case**
- [ ] No files violate naming canon

### Code Standards
- [ ] VTID constants are in **UPPERCASE** (e.g., `const VTID = 'DEV-CICDL-0031'`)
- [ ] Event types/kinds use **snake_case** (e.g., `workflow_run`, `task.init`)
- [ ] Status values use **lowercase** (e.g., `success`, `failure`, `in_progress`)

### Cloud Run Deployments
- [ ] All Cloud Run services include required labels:
  - `vtid`: Full VTID (e.g., `DEV-CICDL-0031`)
  - `vt_layer`: Layer code (e.g., `CICDL`)
  - `vt_module`: Module name (e.g., `GATEWAY`)
- [ ] Deploy scripts use `ensure-vtid.sh` guard

### Documentation
- [ ] VTID mentioned in commit messages
- [ ] Phase 2B compliance verified
- [ ] No non-compliant files introduced

---

## 🔗 Links

- **VTID Tracker:** [Link if applicable]
- **Related PRs:** [List related PRs]
- **Documentation:** [Link to docs]

---

## 🚨 Breaking Changes

_List any breaking changes, or write "None"_

---

## 📸 Screenshots (if applicable)

_Add screenshots or recordings demonstrating the changes_

---

## 👀 Reviewers

@[username] - Required review

---

## 📌 Additional Notes

_Any other context or information for reviewers_
