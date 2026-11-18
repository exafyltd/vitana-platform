-- VTID-05803: undo the dump's session settings (search_path='' and friends) before the package SQL runs.
RESET ALL;
