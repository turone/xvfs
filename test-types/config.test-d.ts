// VfsConfig: the raw configuration as README describes it and config.js
// takes it; the resolved forms, leaf by leaf; what the declarations must
// refuse.

import { VfsConfig } from 'xvfs';
import type {
  DeepReadonly,
  Encoding,
  ResolvedCompress,
  ResolvedFsDomain,
  ResolvedImportDomain,
  ResolvedRequireDomain,
  ResolvedScript,
  VfsRawConfig,
} from 'xvfs';
import { expectType } from './expect.js';

// --- The README configurations ---

const quickStart = new VfsConfig({
  defaults: {
    memory: { limit: '1 gib', segmentSize: '64 mib', maxFileSize: '10 mb' },
  },
  places: {
    static: { fs: { ext: ['html', 'css', 'js', 'png', 'svg'] } },
    lib: { fs: { ext: ['js'] }, require: { compile: ['js'] } },
    scratch: { provider: 'map', origin: 'virtual', fs: { writable: true } },
  },
});

new VfsConfig({
  defaults: {
    memory: { limit: 4 * 1024 * 1024, segmentSize: 262144, maxFileSize: 65536 },
    compaction: { threshold: 0 },
    hooks: { fs: true, module: false },
    watch: true,
    watchTimeout: 250,
    strict: true,
    links: 'deny',
  },
  places: {
    uploads: { provider: 'disk', fs: { writable: true }, links: 'verify' },
    application: {
      fs: {
        ext: ['css'],
        prepare: { api: ['js'], styles: ['css'] },
        script: { compile: ['js'] },
      },
      require: { compile: ['js'] },
    },
    handlers: { fs: { prepare: 'api', script: { compile: ['js'] } } },
    views: {
      fs: {
        ext: ['json'],
        script: { ext: ['mjs'], compile: ['js', 'cjs', 'dhtml'] },
      },
      require: { ext: ['json'], compile: ['js', 'cjs', 'dhtml'] },
    },
    modules: { fs: { script: { ext: ['mjs'] } } },
    static: {
      fs: {
        ext: ['html', 'css', 'js', 'svg', 'png', 'mp4'],
        compress: {
          encodings: ['br', 'gzip'],
          options: { br: { level: 5 } },
          ext: 'compressible',
          retainRaw: true,
        },
      },
    },
    zip: {
      fs: { ext: ['txt'], compress: { encodings: ['gzip'], retainRaw: false } },
    },
    public: { fs: { ext: ['html', 'css', 'js'], fallback: 'disk' } },
    agent: {
      provider: 'map',
      origin: 'virtual',
      fs: { writable: true },
      require: true,
    },
    live: { origin: 'virtual', fs: { writable: true, zeroCopy: true } },
    pub: { provider: 'sea', fs: true, maxFileSize: '2 mib' },
    node: { provider: 'node-default', fs: true },
    disk: { provider: 'disk', fs: { writable: true }, enabled: false },
    esm: { import: { ext: ['js', 'mjs'], prepare: 'api' }, require: false },
    plain: { fs: { compress: null, script: false } },
  },
});

// What the runtime takes as "not given": null sections and codec options.
new VfsConfig({
  defaults: null,
  places: {
    p: {
      fs: { compress: { encodings: ['br'], options: { br: null }, ext: null } },
    },
  },
});

// Every place absent, every domain off: the constructor validates at runtime.
new VfsConfig({});
new VfsConfig();

// A config object typed as such, then handed over.
const raw: VfsRawConfig = {
  places: { static: { fs: { ext: ['html'] } } },
};
raw.defaults = { strict: false };
new VfsConfig(raw);

// --- Resolved forms, leaf by leaf ---

expectType<{
  readonly memory: {
    readonly limit: number;
    readonly segmentSize: number;
    readonly maxFileSize: number;
  };
  readonly compaction: { readonly threshold: number };
  readonly hooks: { readonly fs: boolean; readonly module: boolean };
  readonly watch: boolean;
  readonly watchTimeout: number;
  readonly strict: boolean;
  readonly links: 'deny' | 'verify' | null;
}>()(quickStart.global);

type Place = {
  readonly name: string;
  readonly enabled: boolean;
  readonly provider: 'sab' | 'map' | 'sea' | 'disk' | 'node-default';
  readonly origin: 'disk' | 'virtual' | null;
  readonly maxFileSize: number;
  readonly fs: ResolvedFsDomain | null;
  readonly require: ResolvedRequireDomain | null;
  readonly import: ResolvedImportDomain | null;
  readonly scanExt: readonly string[] | null;
  readonly prepare: { readonly [ext: string]: string } | null;
  readonly links: 'deny' | 'verify' | null;
};
expectType<Place[]>()(quickStart.places);
expectType<Place[]>()(quickStart.allPlaces);
expectType<Place | null>()(quickStart.place('static'));

const lib = quickStart.place('lib');
if (lib?.fs && lib.require && lib.import) {
  expectType<{
    readonly ext: readonly string[] | null;
    readonly writable: boolean;
    readonly zeroCopy: boolean;
    readonly compress: ResolvedCompress | null;
    readonly script: ResolvedScript | null;
    readonly fallback: 'disk' | 'deny' | null;
  }>()(lib.fs);
  expectType<{
    readonly ext: readonly string[];
    readonly compile: readonly string[];
  }>()(lib.require);
  expectType<{ readonly ext: readonly string[] }>()(lib.import);
  expectType<string | undefined>()(lib.prepare?.['js']);
  if (lib.fs.compress && lib.fs.script) {
    expectType<{
      readonly codecs: readonly {
        readonly encoding: Encoding;
        readonly options: { readonly level: number } | null;
      }[];
      readonly ext: readonly string[] | null;
      readonly retainRaw: boolean;
    }>()(lib.fs.compress);
    expectType<{
      readonly ext: readonly string[];
      readonly compile: readonly string[];
    }>()(lib.fs.script);
  }
}

// `raw` is the deep-frozen input: what a worker rebuilds the config from.
expectType<DeepReadonly<VfsRawConfig>>()(quickStart.raw);
new VfsConfig(quickStart.raw);
const staticFs = quickStart.raw.places?.['static']?.fs;
if (typeof staticFs === 'object') {
  expectType<readonly string[] | undefined>()(staticFs.ext);
}

// --- CLI overrides ---

expectType<VfsConfig>()(VfsConfig.fromArgv(process.argv));
VfsConfig.fromArgv(['node', 'app.js', '--', '--vfs.defaults.strict=true'], raw);

// --- Refusals ---

// @ts-expect-error unknown top-level key
new VfsConfig({ options: {} });
// @ts-expect-error `places` is an object of places
new VfsConfig({ places: [{ fs: true }] });
// @ts-expect-error a place is an object, not a directory name
new VfsConfig({ places: { static: './static' } });
// @ts-expect-error unknown place option: the name is the directory
new VfsConfig({ places: { static: { dir: 'static', fs: true } } });
// @ts-expect-error unknown provider
new VfsConfig({ places: { p: { provider: 'redis', fs: true } } });
// @ts-expect-error unknown origin
new VfsConfig({ places: { p: { origin: 'sea', fs: true } } });
// @ts-expect-error `fs.ext` is a list of extensions
new VfsConfig({ places: { p: { fs: { ext: 'js' } } } });
// @ts-expect-error booleans must be booleans
new VfsConfig({ places: { p: { fs: { writable: 'yes' } } } });
// @ts-expect-error unknown encoding
new VfsConfig({ places: { p: { fs: { compress: { encodings: ['lz4'] } } } } });
// @ts-expect-error `encodings` is required
new VfsConfig({ places: { p: { fs: { compress: { ext: 'compressible' } } } } });
new VfsConfig({
  places: {
    p: {
      fs: {
        compress: {
          encodings: ['br'],
          // @ts-expect-error a codec level is a number
          options: { br: { level: '5' } },
        },
      },
    },
  },
});
// @ts-expect-error unknown fallback
new VfsConfig({ places: { p: { fs: { fallback: 'never' } } } });
// @ts-expect-error `links` is 'deny' or 'verify': no 'allow'
new VfsConfig({ defaults: { strict: true, links: 'allow' } });
// @ts-expect-error `links` is 'deny' or 'verify'
new VfsConfig({ places: { p: { provider: 'disk', fs: true, links: true } } });
// @ts-expect-error a preparer is named, never passed as a function
new VfsConfig({ places: { p: { fs: { ext: ['js'], prepare: () => 'x' } } } });
new VfsConfig({
  // @ts-expect-error the object form routes extensions to names
  places: { p: { fs: { ext: ['js'], prepare: { api: 'js' } } } },
});
// @ts-expect-error `compile` lists extensions: no boolean
new VfsConfig({ places: { p: { require: { compile: true } } } });
// @ts-expect-error `fs.script` names its sources: no `true`
new VfsConfig({ places: { p: { fs: { script: true } } } });
// @ts-expect-error `fs.script` lists `ext`, `compile` or both
new VfsConfig({ places: { p: { fs: { script: {} } } } });
// @ts-expect-error `fs.script.compile` lists extensions: no boolean
new VfsConfig({ places: { p: { fs: { script: { compile: false } } } } });
// @ts-expect-error `compile` is a list, not one extension
new VfsConfig({ places: { p: { require: { compile: 'js' } } } });
// @ts-expect-error `import` takes no `compile`
new VfsConfig({ places: { p: { import: { compile: ['js'] } } } });
// @ts-expect-error `strict` is a boolean
new VfsConfig({ defaults: { strict: 'true' } });
// @ts-expect-error a size is a number or a string
new VfsConfig({ defaults: { memory: { limit: true } } });
// @ts-expect-error `hooks` are booleans
new VfsConfig({ defaults: { hooks: { fs: 'on' } } });
// @ts-expect-error `watchTimeout` is a number
new VfsConfig({ defaults: { watchTimeout: '1s' } });
// @ts-expect-error `enabled` is a boolean
new VfsConfig({ places: { p: { enabled: 'no', fs: true } } });
// @ts-expect-error a domain is on, off or an object — never null
new VfsConfig({ places: { p: { fs: null } } });
// @ts-expect-error `places` is never null
new VfsConfig({ places: null });
// @ts-expect-error `fromArgv` takes the argv strings
VfsConfig.fromArgv('--vfs.defaults.strict=true');

// The resolved forms are frozen.
// @ts-expect-error read-only
quickStart.global.strict = true;
// @ts-expect-error read-only
quickStart.global.memory.limit = 0;
// @ts-expect-error read-only
quickStart.raw.defaults = {};
const [first] = quickStart.places;
if (first?.fs) {
  // @ts-expect-error read-only
  first.enabled = false;
  // @ts-expect-error read-only
  first.fs.writable = true;
}
