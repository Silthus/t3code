Lens: Design

Is this the simplest code that meets the goal, and is it clean?
- Simple design, in order: it passes the tests, reveals its intent, says each thing once, and has no superfluous parts.
- Removal first: every new branch, flag, fallback, alias, mode, or parameter that the goal does not need. The fix is to delete it.
- Names and small functions that explain the code instead of comments, YAGNI.
- Naming: names that hide what a thing holds or does, stale copied names.
- Fit: the idioms and patterns of the surrounding code (other workflows in .github/workflows, other scripts).
Leave untouched lines alone, and leave short, clear code unextracted.
