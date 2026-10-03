Lens: Correctness

Does the code do what the goal asks, for every input it will meet?
- Trace one concrete input through each new branch. Look for results that are wrong but silent.
- Boundaries: empty, single, huge, malformed, duplicate, and off-by-one inputs.
- Data mapping between layers, type coercions, and state mutations.
- Async: races on shared state.
- Error paths: what the caller sees when each dependency fails.
- Goal fit: every part of the goal done, and no behaviour the goal does not ask for.
