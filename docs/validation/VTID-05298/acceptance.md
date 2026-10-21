# Acceptance — VTID-05298 lane-paths widening (native-wave2 scope fix)

Spec/docs-only coordinator change: widen the three native-wave2 lane `paths` so Lane scope passes. No
runtime code, migration, or deploy.

AC-1: the news lane paths include ports/news.ts, tests/news/**, and the core-closure generated file.
TEST: grep -c "src/ports/news.ts\|tests/news\|mobile-ci-paths.generated.json" .kiro/specs/native-wave2-home-feed-news/lanes/news.md  # => 3

AC-2: home and community-hub lanes get the matching ports/tests/generated-file globs.
TEST: grep -l "mobile-ci-paths.generated.json" .kiro/specs/native-wave2-home-feed-news/lanes/home.md .kiro/specs/native-wave2-home-feed-news/lanes/community-hub.md  # => both files

AC-3: no runtime/code change; OASIS impact none.
TEST: git diff --name-only origin/main...HEAD  # => only .kiro/specs/native-wave2-home-feed-news/lanes/*.md and docs/validation/VTID-05298/**

See commands.log and outputs/.
