export declare const MAX_BRAND_NAME_LENGTH: number;
export declare function readBrandingFile(): {
  name?: unknown;
  icon?: unknown;
  wordmark?: unknown;
};
export declare function brandName(file?: { name?: unknown }): string;
export declare function binaryName(name?: string): string;
