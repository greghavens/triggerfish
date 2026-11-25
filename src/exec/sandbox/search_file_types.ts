/** Resolve content search types to the filename extensions they include. */

const FILE_TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  c: ["c", "h"],
  cpp: ["cc", "cpp", "cxx", "h", "hh", "hpp", "hxx"],
  cs: ["cs"],
  css: ["css", "less", "sass", "scss"],
  go: ["go"],
  html: ["htm", "html"],
  java: ["java"],
  js: ["cjs", "js", "jsx", "mjs", "vue"],
  json: ["json"],
  kotlin: ["kt", "kts"],
  markdown: ["markdown", "md"],
  php: ["php"],
  proto: ["proto"],
  python: ["py", "pyi"],
  ruby: ["rb"],
  rust: ["rs"],
  sh: ["bash", "sh", "zsh"],
  sql: ["sql"],
  swift: ["swift"],
  toml: ["toml"],
  ts: ["cts", "mts", "ts", "tsx"],
  xml: ["xml"],
  yaml: ["yaml", "yml"],
};

const FILE_TYPE_ALIASES = new Map([
  ["javascript", "js"],
  ["md", "markdown"],
  ["py", "python"],
  ["rb", "ruby"],
  ["typescript", "ts"],
]);

export function searchFileTypeExtensions(type: string): readonly string[] {
  const normalized = type.toLowerCase();
  const key = FILE_TYPE_ALIASES.get(normalized) ?? normalized;
  return Object.hasOwn(FILE_TYPE_EXTENSIONS, key)
    ? FILE_TYPE_EXTENSIONS[key]
    : [key];
}

export function isSearchFileType(value: unknown): value is string {
  return typeof value === "string" && /^[a-z\d][a-z\d_+-]{0,31}$/i.test(value);
}
