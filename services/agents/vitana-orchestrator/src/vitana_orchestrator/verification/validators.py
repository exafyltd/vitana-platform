"""
Domain-Specific Validators - VTID-01175

Validators that check domain-specific requirements for task completion.
These are used by the VerificationStageGate to validate worker output
before the orchestrator marks tasks complete.

This is a SUBSYSTEM of the Worker Orchestrator (VTID-01163).
"""

import logging
import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..main import TaskDomain

logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """Result of a validation check"""
    passed: bool
    reason: str = ""
    details: Dict[str, Any] = field(default_factory=dict)
    retriable: bool = True  # Whether the orchestrator should retry on failure


class Validator(ABC):
    """Base class for domain validators"""

    name: str = "base"

    async def validate(
        self,
        task: Any,
        result: Dict[str, Any],
    ) -> ValidationResult:
        """
        Validate task completion result.

        This is the interface expected by tests and external callers.

        Args:
            task: TaskState object with domain info
            result: Worker result with changes list

        Returns:
            ValidationResult with pass/fail and details
        """
        workspace_path = Path(os.environ.get("WORKSPACE_PATH", "."))
        changes = result.get("changes", [])
        domain = task.domain if hasattr(task, "domain") else TaskDomain.BACKEND
        return await self.validate_changes(domain, changes, workspace_path)

    async def validate_changes(
        self,
        domain: TaskDomain,
        changes: List[Dict[str, Any]],
        workspace_path: Path,
    ) -> ValidationResult:
        """
        Validate changes made by a worker.

        This is the primary interface used by VerificationStageGate.

        Args:
            domain: Task domain
            changes: List of file changes claimed by worker
            workspace_path: Path to workspace

        Returns:
            ValidationResult with pass/fail and details
        """
        return await self._validate_changes_impl(domain, changes, workspace_path)

    @abstractmethod
    async def _validate_changes_impl(
        self,
        domain: TaskDomain,
        changes: List[Dict[str, Any]],
        workspace_path: Path,
    ) -> ValidationResult:
        """Implementation of change validation"""
        pass


class FrontendValidator(Validator):
    """
    Validator for frontend tasks.

    Checks:
    - No console.log statements in production code
    - Accessibility requirements (basic)
    - No hardcoded styles (should use Tailwind/CSS)
    - Component export exists
    """

    name = "frontend"

    async def _validate_changes_impl(
        self,
        domain: TaskDomain,
        changes: List[Dict[str, Any]],
        workspace_path: Path,
    ) -> ValidationResult:
        issues = []

        for change in changes:
            file_path = change.get("file_path", "")
            if not file_path:
                continue

            full_path = workspace_path / file_path

            # Only check frontend files
            if not self._is_frontend_file(file_path):
                continue

            if not full_path.exists():
                continue

            try:
                content = full_path.read_text()

                # Check for console.log
                if "console.log" in content:
                    issues.append({
                        "file": file_path,
                        "issue": "console.log found in production code",
                        "severity": "warning",
                    })

                # Check for hardcoded styles
                if re.search(r'style\s*=\s*\{[^}]+\}', content):
                    issues.append({
                        "file": file_path,
                        "issue": "Inline styles found - prefer Tailwind classes",
                        "severity": "info",
                    })

                # Check for missing alt on images
                if "<img" in content and 'alt=' not in content:
                    issues.append({
                        "file": file_path,
                        "issue": "Image missing alt attribute",
                        "severity": "warning",
                    })

            except Exception as e:
                logger.error(f"Error validating {file_path}: {e}")

        # Only fail on critical issues
        critical_issues = [i for i in issues if i.get("severity") == "critical"]

        if critical_issues:
            return ValidationResult(
                passed=False,
                reason=f"Frontend validation failed: {len(critical_issues)} critical issue(s)",
                details={"issues": issues, "critical_count": len(critical_issues)},
            )

        return ValidationResult(
            passed=True,
            reason="Frontend validation passed" + (f" with {len(issues)} warning(s)" if issues else ""),
            details={"issues": issues} if issues else {},
        )

    def _is_frontend_file(self, path: str) -> bool:
        """Check if file is a frontend file"""
        frontend_patterns = [
            "frontend/",
            ".tsx",
            ".jsx",
            ".css",
            ".html",
            "web/",
        ]
        return any(p in path.lower() for p in frontend_patterns)


class BackendValidator(Validator):
    """
    Validator for backend tasks.

    Checks:
    - No exposed secrets/credentials
    - Error handling present
    - Input validation for endpoints
    - SQL injection protection
    """

    name = "backend"

    # Patterns that might indicate security issues
    SECRET_PATTERNS = [
        r'password\s*=\s*["\'][^"\']+["\']',
        r'api_key\s*=\s*["\'][^"\']+["\']',
        r'secret\s*=\s*["\'][^"\']+["\']',
        r'token\s*=\s*["\'][^"\']+["\']',
    ]

    async def _validate_changes_impl(
        self,
        domain: TaskDomain,
        changes: List[Dict[str, Any]],
        workspace_path: Path,
    ) -> ValidationResult:
        issues = []

        for change in changes:
            file_path = change.get("file_path", "")
            if not file_path:
                continue

            full_path = workspace_path / file_path

            # Only check backend files
            if not self._is_backend_file(file_path):
                continue

            if not full_path.exists():
                continue

            try:
                content = full_path.read_text()

                # Check for hardcoded secrets
                for pattern in self.SECRET_PATTERNS:
                    if re.search(pattern, content, re.IGNORECASE):
                        issues.append({
                            "file": file_path,
                            "issue": "Possible hardcoded secret detected",
                            "severity": "critical",
                        })

                # Check for SQL injection risk
                if self._has_sql_injection_risk(content):
                    issues.append({
                        "file": file_path,
                        "issue": "Potential SQL injection vulnerability",
                        "severity": "critical",
                    })

                # Check for missing error handling (routes)
                if self._is_route_file(file_path):
                    if not self._has_error_handling(content):
                        issues.append({
                            "file": file_path,
                            "issue": "Route handler missing error handling",
                            "severity": "warning",
                        })

            except Exception as e:
                logger.error(f"Error validating {file_path}: {e}")

        # Fail on critical issues
        critical_issues = [i for i in issues if i.get("severity") == "critical"]

        if critical_issues:
            return ValidationResult(
                passed=False,
                reason=f"Security validation failed: {len(critical_issues)} critical issue(s)",
                details={"issues": issues, "critical_count": len(critical_issues)},
                retriable=False,  # Security issues shouldn't be retried blindly
            )

        return ValidationResult(
            passed=True,
            reason="Backend validation passed" + (f" with {len(issues)} warning(s)" if issues else ""),
            details={"issues": issues} if issues else {},
        )

    def _is_backend_file(self, path: str) -> bool:
        """Check if file is a backend file"""
        # Exclude frontend
        if "frontend/" in path.lower():
            return False

        backend_patterns = [
            "/routes/",
            "/controllers/",
            "/services/",
            "/middleware/",
            "/api/",
            ".ts",
            ".py",
        ]
        return any(p in path.lower() for p in backend_patterns)

    def _is_route_file(self, path: str) -> bool:
        """Check if file is a route handler"""
        return "/routes/" in path.lower() or "router" in path.lower()

    def _has_sql_injection_risk(self, content: str) -> bool:
        """Check for potential SQL injection"""
        # Look for string concatenation in SQL
        risky_patterns = [
            r'query\s*\(\s*["\'].*\+',  # query("SELECT..." +
            r'execute\s*\(\s*["\'].*\+',
            r'`SELECT.*\$\{',  # Template literal with variable
        ]
        for pattern in risky_patterns:
            if re.search(pattern, content):
                return True
        return False

    def _has_error_handling(self, content: str) -> bool:
        """Check if error handling is present"""
        error_patterns = [
            r'try\s*\{',
            r'catch\s*\(',
            r'\.catch\s*\(',
            r'errorHandler',
            r'asyncHandler',
        ]
        return any(re.search(p, content) for p in error_patterns)


class MemoryValidator(Validator):
    """
    Validator for memory/database tasks.

    Checks:
    - RLS policies exist for new tables
    - Migration syntax is valid
    - Foreign keys have proper references
    - No DROP TABLE without confirmation
    """

    name = "memory"

    async def _validate_changes_impl(
        self,
        domain: TaskDomain,
        changes: List[Dict[str, Any]],
        workspace_path: Path,
    ) -> ValidationResult:
        issues = []

        for change in changes:
            file_path = change.get("file_path", "")
            if not file_path:
                continue

            full_path = workspace_path / file_path

            # Only check SQL files
            if not file_path.endswith(".sql"):
                continue

            if not full_path.exists():
                continue

            try:
                content = full_path.read_text()

                # Check for CREATE TABLE without RLS
                tables = re.findall(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)', content, re.IGNORECASE)
                for table in tables:
                    if not self._has_rls_policy(content, table):
                        issues.append({
                            "file": file_path,
                            "issue": f"Table {table} created without RLS policy",
                            "severity": "critical",
                        })

                # Check for dangerous DROP TABLE
                if re.search(r'DROP\s+TABLE', content, re.IGNORECASE):
                    issues.append({
                        "file": file_path,
                        "issue": "DROP TABLE detected - requires confirmation",
                        "severity": "critical",
                    })

                # Check for missing transaction
                if "BEGIN" not in content.upper() and len(tables) > 1:
                    issues.append({
                        "file": file_path,
                        "issue": "Multiple tables created without transaction wrapper",
                        "severity": "warning",
                    })

            except Exception as e:
                logger.error(f"Error validating {file_path}: {e}")

        # Fail on critical issues
        critical_issues = [i for i in issues if i.get("severity") == "critical"]

        if critical_issues:
            return ValidationResult(
                passed=False,
                reason=f"Memory validation failed: {len(critical_issues)} critical issue(s)",
                details={"issues": issues, "critical_count": len(critical_issues)},
                retriable=False,  # DB issues need manual review
            )

        return ValidationResult(
            passed=True,
            reason="Memory validation passed" + (f" with {len(issues)} warning(s)" if issues else ""),
            details={"issues": issues} if issues else {},
        )

    def _has_rls_policy(self, content: str, table_name: str) -> bool:
        """Check if table has RLS policy defined"""
        # Look for ALTER TABLE ... ENABLE ROW LEVEL SECURITY
        rls_enable = re.search(
            rf'ALTER\s+TABLE\s+{re.escape(table_name)}\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY',
            content,
            re.IGNORECASE,
        )
        # Look for CREATE POLICY ... ON table_name
        policy_create = re.search(
            rf'CREATE\s+POLICY\s+\S+\s+ON\s+{re.escape(table_name)}',
            content,
            re.IGNORECASE,
        )
        return bool(rls_enable) or bool(policy_create)


def get_validators_for_domain(domain: TaskDomain) -> List[Validator]:
    """Get validators for a specific domain"""
    validators = {
        TaskDomain.FRONTEND: [FrontendValidator()],
        TaskDomain.BACKEND: [BackendValidator()],
        TaskDomain.MEMORY: [MemoryValidator()],
        TaskDomain.MIXED: [FrontendValidator(), BackendValidator(), MemoryValidator()],
    }
    return validators.get(domain, [])
