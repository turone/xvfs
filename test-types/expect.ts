// Type assertions of the type tests. Nothing here runs: `tsc --noEmit`
// checks the files of this directory against the package's declarations.

// Identical types, as the compiler compares them: `any`, `never`,
// `readonly` and optional modifiers all count.
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

// `expectType<T>()(value)`: `value` has exactly the type `T`, or the call
// does not compile — a mismatch demands a second argument nothing can be,
// so a `never` value is refused like any other.
export const expectType =
  <Expected>() =>
  <Actual>(
    value: Actual,
    ...mismatch: Equal<Expected, Actual> extends true ? [] : [never]
  ) => {
    void value;
    void mismatch;
  };
