// Types of register.mjs, the bootstrap entry:
//   node --import xvfs/register app.js -- --vfs.config=path
// A side effect only — it loads the config, initializes the kernel,
// installs the hooks and publishes `VfsKernel.current` — with no exports.

export {};
