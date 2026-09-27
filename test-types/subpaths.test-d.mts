// The package from an ES module: its entry and subpaths — `./register` is
// a side effect, the adapters install and uninstall over a kernel — and
// the `kernel` getter, which ESM reads from the default import.

import 'shared-memory-fs/register';
import * as fsPatch from 'shared-memory-fs/adapters/fs-patch';
import { install, uninstall } from 'shared-memory-fs/adapters/module-hook';
import pkg from 'shared-memory-fs';
import * as ns from 'shared-memory-fs';
import { VfsKernel } from 'shared-memory-fs';
import { expectType } from './expect.js';

declare const kernel: VfsKernel;

expectType<void>()(fsPatch.install(kernel));
expectType<void>()(fsPatch.uninstall());
expectType<void>()(install(kernel));
expectType<void>()(uninstall());
// No named `kernel` export reaches an ES module (README): the getter of
// the default import, or `VfsKernel.current`.
expectType<VfsKernel | null>()(pkg.kernel);
expectType<VfsKernel | null>()(ns.default.kernel);
expectType<VfsKernel | null>()(VfsKernel.current);
expectType<typeof VfsKernel>()(pkg.VfsKernel);

// @ts-expect-error a kernel is required
fsPatch.install();
// A VfsKernel instance, not a look-alike: the class is nominal.
declare const lookalike: Pick<VfsKernel, keyof VfsKernel>;
// @ts-expect-error not a VfsKernel
install(lookalike);
// @ts-expect-error uninstall takes nothing
uninstall(kernel);
