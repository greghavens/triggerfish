/** Typed properties of an observed asset and bounded Boolean inventory selectors. */
import { isIP } from "node:net";
import { redactCredentialText } from "../core/logger/redactor.ts";
import { isSentinelCaseId } from "./cases.ts";

const textFields = [
  "service",
  "technology",
  "url",
  "title",
  "ip",
  "domain",
  "registrationId",
  "rootDomain",
  "appName",
  "appDescription",
  "bundleId",
  "category",
  "appRegistrationId",
  "method",
  "serviceType",
  "recordType",
] as const;
type TextField = typeof textFields[number];
type NumericField = "port" | "status";
type ContextField = "caseId" | "organizationId";

export type SentinelAssetProperties =
  & { readonly [Field in TextField]?: readonly string[] }
  & { readonly [Field in NumericField]?: readonly number[] };

export type SentinelAssetQuery =
  | { readonly and: readonly SentinelAssetQuery[] }
  | { readonly or: readonly SentinelAssetQuery[] }
  | { readonly not: SentinelAssetQuery }
  | {
    readonly field: ContextField;
    readonly op: "eq";
    readonly value: string;
  }
  | {
    readonly field: TextField;
    readonly op: "contains" | "not_contains" | "eq" | "ne";
    readonly value: string;
  }
  | {
    readonly field: NumericField;
    readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
    readonly value: number;
  };

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

export function assetText(value: unknown, max = 512): string | undefined {
  if (
    typeof value !== "string" || !value || value.length > max ||
    value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value) ||
    redactCredentialText(value) !== value
  ) return;
  return value.normalize("NFC");
}

export function canonicalAssetDomain(value: string): string | undefined {
  const domain = value.toLowerCase().replace(/\.$/, "");
  if (
    domain.length <= 253 && domain.split(".").length >= 2 &&
    !isIP(domain) &&
    domain.split(".").every((part) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)
    )
  ) return domain;
}

export function canonicalAssetIp(value: string): string | undefined {
  if (isIP(value) === 4) return value;
  if (isIP(value) === 6 && !value.includes("%")) {
    return new URL(`http://[${value}]`).hostname.slice(1, -1);
  }
}

export function canonicalAssetUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username && !url.password && !url.search && !url.hash
    ) return url.href;
  } catch {
    return;
  }
}

/** Keep bounded descriptive metadata and omit strings that could carry credentials. */
export function parseSentinelAppDescription(
  value: unknown,
): string | undefined {
  const text = assetText(value);
  if (
    !text ||
    /\b(?:password|passwd|secret|token|api[ _-]?key|authorization|cookie|credential)[s]?["']?\s*[:=]/i
      .test(text) ||
    /\b(?:bearer|basic)\s+[A-Za-z0-9+/._=-]{8,}/i.test(text) ||
    (text.match(/\bhttps?:\/\/[^\s<>"']+/gi) ?? []).some((url) =>
      !canonicalAssetUrl(url)
    )
  ) return;
  return text;
}

function textProperty(field: TextField, value: unknown) {
  const text = assetText(value);
  if (!text) return;
  switch (field) {
    case "domain":
    case "rootDomain":
      return canonicalAssetDomain(text);
    case "ip":
      return canonicalAssetIp(text);
    case "url":
      return canonicalAssetUrl(text);
    case "title":
    case "appDescription":
      return parseSentinelAppDescription(text);
    case "appName":
    case "bundleId":
      return text;
    case "method":
    case "recordType":
      return /^[a-z][a-z0-9_-]{0,31}$/i.test(text)
        ? text.toUpperCase()
        : undefined;
    default:
      return text.toLowerCase();
  }
}

function numberProperty(field: NumericField, value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    (field === "port"
      ? value >= 1 && value <= 65535
      : value >= 100 && value <= 599);
}

/** Reject an invalid property bag before including it in an immutable snapshot. */
export function parseSentinelAssetProperties(
  input: unknown,
): SentinelAssetProperties | undefined {
  const raw = object(input);
  if (!raw || Object.keys(raw).length === 0) return;
  const out: Record<string, readonly (string | number)[]> = {};
  for (const key of Object.keys(raw).sort()) {
    const values = raw[key];
    if (!Array.isArray(values) || !values.length || values.length > 12) return;
    if (key === "port" || key === "status") {
      if (!values.every((value) => numberProperty(key, value))) return;
      out[key] = Object.freeze(
        [...new Set<number>(values)].sort((a, b) => a - b),
      );
      continue;
    }
    const field = textFields.find((field) => field === key);
    if (!field) return;
    const parsed = values.map((value) => textProperty(field, value));
    if (parsed.some((value) => value === undefined)) return;
    out[key] = Object.freeze([...new Set(parsed as string[])].sort());
  }
  return Object.freeze(out);
}

const dslFields = new Map<string, TextField | NumericField | ContextField>([
  ...textFields.map((field) => [field.toLowerCase(), field] as const),
  ["case_id", "caseId"],
  ["company_id", "organizationId"],
  ["organization_id", "organizationId"],
  ["service_name", "service"],
  ["page_title", "title"],
  ["icp", "registrationId"],
  ["tech", "technology"],
  ["technologies", "technology"],
  ["port", "port"],
  ["status", "status"],
  ["status_code", "status"],
  ["root_domain", "rootDomain"],
  ["app_name", "appName"],
  ["app_description", "appDescription"],
  ["bundle_id", "bundleId"],
  ["app_icp", "appRegistrationId"],
  ["service_type", "serviceType"],
  ["record_type", "recordType"],
]);

/** Compile bounded inventory expressions into the existing typed selector. */
function parseAssetSearchText(text: string): unknown {
  if (!text.trim() || text.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(text)) {
    return;
  }
  const parts = text.match(/"[^"]*"|!=|==|>=|<=|[()=<>]|[^\s"()=<>!]+|./gu);
  if (!parts || parts.length > 128) return;
  const tokens = parts.filter((part) => part.trim());
  let cursor = 0;
  const peek = () => tokens[cursor];

  function group(operator: "AND" | "OR", next: () => unknown): unknown {
    const first = next();
    if (!first) return;
    const children = [first];
    while (peek()?.toUpperCase() === operator) {
      cursor++;
      const child = next();
      if (!child) return;
      children.push(child);
    }
    return children.length === 1
      ? first
      : { [operator.toLowerCase()]: children };
  }

  function expression(depth: number): unknown {
    if (depth > 5) return;
    return group("OR", () => group("AND", () => atom(depth)));
  }

  function atom(depth: number): unknown {
    const name = tokens[cursor++];
    if (!name) return;
    if (name === "(") {
      const nested = expression(depth + 1);
      return tokens[cursor++] === ")" ? nested : undefined;
    }
    if (/^(?:AND|OR|[()=<>!"]|!=|==|>=|<=)$/i.test(name)) return;
    const op = peek();
    if (op && /^(?:!=|==|>=|<=|[=<>])$/.test(op)) {
      cursor++;
      const field = dslFields.get(name.toLowerCase());
      const raw = tokens[cursor++];
      if (!field || !raw || /^(?:AND|OR|[()=<>!"]|!=|==|>=|<=)$/i.test(raw)) {
        return;
      }
      const value = raw.startsWith('"') ? raw.slice(1, -1) : raw;
      if (field === "caseId" || field === "organizationId") {
        return op === "=" || op === "=="
          ? { field, op: "eq", value }
          : undefined;
      }
      if (field === "port" || field === "status") {
        if (!/^\d+$/.test(value)) return;
        const numericOps = new Map([
          ["=", "eq"],
          ["==", "eq"],
          ["!=", "ne"],
          [">", "gt"],
          [">=", "gte"],
          ["<", "lt"],
          ["<=", "lte"],
        ]);
        return { field, op: numericOps.get(op), value: Number(value) };
      }
      if (op === "=" || op === "==") {
        return { field, op: op === "=" ? "contains" : "eq", value };
      }
      if (op === "!=") {
        if (field === "technology") return { not: { field, op: "eq", value } };
        return { field, op: "not_contains", value };
      }
      return;
    }
    const value = name.startsWith('"') ? name.slice(1, -1) : name;
    return {
      or: textFields.map((field) => ({ field, op: "contains", value })),
    };
  }
  const result = expression(0);
  return cursor === tokens.length ? result : undefined;
}

/** Parse model-provided JSON without interpreting any part as code or SQL. */
export function parseSentinelAssetQuery(
  input: unknown,
): SentinelAssetQuery | undefined {
  let count = 0;
  function parse(
    value: unknown,
    depth: number,
  ): SentinelAssetQuery | undefined {
    const item = object(value);
    if (!item || ++count > 64 || depth > 5) return;
    const keys = Object.keys(item);
    if (keys.length === 1) {
      if (keys[0] === "not") {
        const child = parse(item.not, depth + 1);
        return child && { not: child };
      }
      const key = keys[0];
      if (key !== "and" && key !== "or") return;
      const entries = item[key];
      if (
        !Array.isArray(entries) || entries.length < 2 || entries.length > 16
      ) return;
      const children = entries.map((entry) => parse(entry, depth + 1));
      if (children.some((child) => child === undefined)) return;
      return key === "and"
        ? { and: children as SentinelAssetQuery[] }
        : { or: children as SentinelAssetQuery[] };
    }
    const { field, op, value: operand } = item;
    if (keys.length !== 3) return;
    if (field === "caseId" || field === "organizationId") {
      const valid = field === "caseId"
        ? isSentinelCaseId(operand)
        : assetText(operand, 256) !== undefined;
      return op === "eq" && valid && typeof operand === "string"
        ? { field, op, value: operand }
        : undefined;
    }
    if (field === "port" || field === "status") {
      if (
        numberProperty(field, operand) &&
        (op === "eq" || op === "ne" || op === "gt" || op === "gte" ||
          op === "lt" || op === "lte")
      ) return { field, op, value: operand };
      return;
    }
    const textField = textFields.find((name) => name === field);
    if (
      !textField ||
      (op !== "contains" && op !== "not_contains" && op !== "eq" && op !== "ne")
    ) return;
    const text = op === "contains" || op === "not_contains"
      ? (textField === "appDescription"
        ? parseSentinelAppDescription(operand)
        : assetText(operand))?.toLowerCase()
      : textProperty(textField, operand);
    return text === undefined
      ? undefined
      : { field: textField, op, value: text };
  }
  const inputObject = object(input);
  if (
    inputObject && Object.keys(inputObject).length === 1 &&
    typeof inputObject.dsl === "string"
  ) return parse(parseAssetSearchText(inputObject.dsl), 0);
  return parse(input, 0);
}

type QueryAsset = {
  readonly id: string;
  readonly label?: string;
  readonly aliases?: readonly string[];
  readonly properties?: SentinelAssetProperties;
  readonly organization?: { readonly id: string };
};

function retainedAssetUrls(asset: QueryAsset): URL[] {
  const addresses = [
    asset.id,
    ...(asset.aliases ?? []),
    ...(asset.properties?.url ?? []),
  ];
  const label = assetText(asset.label);
  const origin = label && canonicalAssetUrl(label);
  // Capture-created assets retain their canonical HTTP origin as the label.
  if (origin && new URL(origin).origin === label) addresses.push(label);
  return addresses.flatMap((value) => {
    const text = assetText(value);
    const href = text && canonicalAssetUrl(text);
    return href ? [new URL(href)] : [];
  });
}

export function sentinelAssetPropertyValues(
  asset: QueryAsset,
  field: TextField,
): readonly string[] {
  const exact = asset.properties?.[field] ?? [];
  if (
    field !== "url" && field !== "domain" && field !== "ip" &&
    field !== "service"
  ) {
    return exact;
  }
  const urls = retainedAssetUrls(asset);
  if (field === "url") return [...exact, ...urls.map((url) => url.href)];
  if (field === "service") {
    return [...exact, ...urls.map((url) => url.protocol.slice(0, -1))];
  }
  const names = [
    asset.id,
    ...(asset.aliases ?? []),
    ...urls.map(({ hostname }) => hostname.replace(/^\[|\]$/g, "")),
  ];
  return [
    ...exact,
    ...names.flatMap((name) => {
      const candidate = textProperty(field, name);
      return candidate ? [candidate] : [];
    }),
  ];
}

export function matchesSentinelAssetQuery(
  asset: QueryAsset,
  expr: SentinelAssetQuery,
  caseId?: string,
): boolean {
  if ("and" in expr) {
    return expr.and.every((child) =>
      matchesSentinelAssetQuery(asset, child, caseId)
    );
  }
  if ("or" in expr) {
    return expr.or.some((child) =>
      matchesSentinelAssetQuery(asset, child, caseId)
    );
  }
  if ("not" in expr) return !matchesSentinelAssetQuery(asset, expr.not, caseId);
  if (expr.field === "caseId") return expr.value === caseId;
  if (expr.field === "organizationId") {
    return expr.value === asset.organization?.id;
  }
  if (expr.field === "port" || expr.field === "status") {
    const { field, op, value } = expr;
    const explicit = asset.properties?.[field] ?? [];
    const values = field === "port"
      ? [
        ...explicit,
        ...retainedAssetUrls(asset).map((url) =>
          url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
        ),
      ]
      : explicit;
    switch (op) {
      case "eq":
        return values.includes(value);
      case "ne":
        return values.length > 0 && !values.includes(value);
      case "gt":
        return values.some((entry) => entry > value);
      case "gte":
        return values.some((entry) => entry >= value);
      case "lt":
        return values.some((entry) => entry < value);
      case "lte":
        return values.some((entry) => entry <= value);
    }
  }
  const { value } = expr;
  if (typeof value !== "string") return false;
  const values = sentinelAssetPropertyValues(asset, expr.field);
  if (expr.op === "eq") return values.includes(value);
  if (expr.op === "ne") {
    return values.length > 0 && !values.includes(value);
  }
  const matches = values.some((entry) => entry.toLowerCase().includes(value));
  return expr.op === "not_contains" ? values.length > 0 && !matches : matches;
}
