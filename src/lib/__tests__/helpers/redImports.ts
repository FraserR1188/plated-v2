// ============================================================
// Red-test loader: load a module that may not exist yet, and fail with a
// message that says exactly why.
//
// Red-test commits (the e4d3ca4 precedent) are written against an API that
// doesn't exist yet. The only acceptable reason for such a test to fail at
// that commit is that the module or export is missing. A static import of a
// missing module fails the whole FILE at transform time (one error, no test
// counts, and tsc errors too); a missing named export from an existing
// module silently binds `undefined`, so the test fails later with a
// TypeError that looks like a real bug.
//
// So each test loads its module through requireExports(), which throws:
//   "module not found: <label>"           the file doesn't exist yet
//   "export not found: <label> → a, b"    the file exists, the export doesn't
// and re-throws any OTHER load error untouched, so a genuinely broken module
// is never disguised as a missing one.
//
// The import() expression must live in the TEST file (a relative path
// resolves against the file containing the import), so callers pass a
// loader: () => import(/* @vite-ignore */ PATH), with PATH a variable so
// neither Vite's import analysis nor tsc tries to resolve it ahead of time.
// ============================================================

const NOT_FOUND = /Failed to load url|Cannot find module|does not exist|ERR_MODULE_NOT_FOUND/i;

export async function requireExports<T>(
  load: () => Promise<unknown>,
  label: string,
  names: string[],
): Promise<T> {
  let mod: Record<string, unknown>;
  try {
    mod = (await load()) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (NOT_FOUND.test(msg)) throw new Error(`module not found: ${label}`);
    throw e;
  }
  const missing = names.filter((n) => !(n in mod));
  if (missing.length) {
    throw new Error(`export not found: ${label} → ${missing.join(", ")}`);
  }
  return mod as T;
}
