/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Package version, injected by `vite.config.ts`. */
  readonly VITE_APP_VERSION: string;
  /** White-label product name, injected by `vite.config.ts`. */
  readonly VITE_BRAND_NAME: string;
  /** White-label brand icon as a `data:` URI, or `""` for none. */
  readonly VITE_BRAND_ICON: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
