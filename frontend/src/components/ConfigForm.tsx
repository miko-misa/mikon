import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface ConfigFormProps {
  schema: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled?: boolean;
  mode?: "edit" | "readonly";
  title?: string;
  description?: string;
}

function prettifyKey(k: string): string {
  return k
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (c) => c.toUpperCase());
}

type Schema = Record<string, unknown>;

function resolveRef(ref: string, rootSchema: Schema): Schema | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = rootSchema;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return (cur as Schema) ?? null;
}

function resolveSchema(schema: Schema, rootSchema: Schema): Schema {
  if (schema.$ref && typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, rootSchema);
    if (resolved) return resolveSchema(resolved, rootSchema);
  }
  return schema;
}

function unwrapOptional(schema: Schema): { schema: Schema; optional: boolean } {
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf as Schema[];
    const nonNull = options.filter(
      (o) => !(o.type === "null" || (Array.isArray(o.type) && o.type.includes("null")))
    );
    if (nonNull.length === 1 && options.length === 2) {
      return { schema: nonNull[0], optional: true };
    }
  }
  return { schema, optional: false };
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function formatValue(value: unknown): string {
  if (value === undefined) return "Not set";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value || "\"\"";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function schemaHints(schema: Schema, optional: boolean): string[] {
  const hints: string[] = [optional ? "optional" : "required"];
  if (schema.default !== undefined) hints.push(`default ${formatValue(schema.default)}`);
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    const min = schema.minimum !== undefined ? String(schema.minimum) : "-∞";
    const max = schema.maximum !== undefined ? String(schema.maximum) : "∞";
    hints.push(`range ${min}–${max}`);
  }
  if (schema.multipleOf !== undefined) hints.push(`step ${schema.multipleOf}`);
  if (Array.isArray(schema.enum)) {
    hints.push(`allowed ${(schema.enum as unknown[]).map(formatValue).join(", ")}`);
  }
  if (schema.const !== undefined) hints.push(`constant ${formatValue(schema.const)}`);
  return hints;
}

function ReadonlyValue({ value }: { value: unknown }) {
  return (
    <div className="min-h-9 rounded-md bg-muted/30 px-3 py-2 font-mono text-sm">
      {formatValue(value)}
    </div>
  );
}

function FieldMeta({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

// Shared 2-column row wrapper for flat (non-object) fields
function FieldRow({
  label,
  description,
  optional,
  children,
  alignTop,
  meta,
}: {
  label: string;
  description?: string;
  optional?: boolean;
  children: React.ReactNode;
  alignTop?: boolean;
  meta?: string[];
}) {
  return (
    <div
      className={cn(
        "grid gap-x-6 py-2 border-b border-border/50 last:border-0",
        "grid-cols-[2fr_3fr]",
        alignTop ? "items-start" : "items-center"
      )}
    >
      <div className={cn(alignTop && "pt-1")}>
        <Label className="text-sm font-medium leading-snug">
          {label}
          {optional && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              (optional)
            </span>
          )}
        </Label>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-snug">
            {description}
          </p>
        )}
      </div>
      <div>{children}</div>
      <div className="col-start-2">
        <FieldMeta items={meta ?? []} />
      </div>
    </div>
  );
}

interface FieldProps {
  fieldKey: string;
  schema: Schema;
  rootSchema: Schema;
  uiSchema?: Record<string, unknown>;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  depth?: number;
  mode: "edit" | "readonly";
  required?: boolean;
}

function Field({
  fieldKey,
  schema: rawSchema,
  rootSchema,
  uiSchema,
  value,
  onChange,
  disabled,
  depth = 0,
  mode,
  required = true,
}: FieldProps) {
  const resolved = resolveSchema(rawSchema, rootSchema);
  const { schema, optional } = unwrapOptional(resolved);
  const fieldUi = (uiSchema?.[fieldKey] ?? {}) as Record<string, unknown>;
  const label = (schema.title as string | undefined) ?? prettifyKey(fieldKey);
  const description = schema.description as string | undefined;
  const isOptional = optional || !required;
  const meta = schemaHints(schema, isOptional);

  // Module ref
  if (schema["x-mikon-module-ref"] != null && Array.isArray(schema.oneOf)) {
    return (
      <ModuleRefField
        label={label}
        description={description}
        options={schema.oneOf as Schema[]}
        rootSchema={rootSchema}
        uiSchema={uiSchema}
        value={value}
        onChange={onChange}
        disabled={disabled}
        depth={depth}
        optional={isOptional}
        mode={mode}
      />
    );
  }

  // Object type
  if (schema.type === "object" && schema.properties) {
    return (
      <ObjectField
        label={label}
        description={description}
        schema={schema}
        rootSchema={rootSchema}
        uiSchema={uiSchema}
        value={value}
        onChange={onChange}
        disabled={disabled}
        depth={depth}
        mode={mode}
        optional={isOptional}
      />
    );
  }

  if (mode === "readonly") {
    return (
      <FieldRow label={label} description={description} optional={isOptional} meta={meta}>
        <ReadonlyValue value={value} />
      </FieldRow>
    );
  }

  // Boolean
  if (schema.type === "boolean") {
    const checked = Boolean(value ?? false);
    return (
      <FieldRow label={label} description={description} optional={isOptional} meta={meta}>
        <Switch
          checked={checked}
          onCheckedChange={(v) => onChange(v)}
          disabled={disabled}
        />
      </FieldRow>
    );
  }

  // Number/integer with range → Slider + number input
  const isRange =
    fieldUi["ui:widget"] === "range" ||
    ((schema.type === "number" || schema.type === "integer") &&
      schema.minimum != null &&
      schema.maximum != null);

  if (isRange && schema.minimum != null && schema.maximum != null) {
    const min = schema.minimum as number;
    const max = schema.maximum as number;
    const step =
      schema.type === "integer"
        ? 1
        : (schema.multipleOf as number | undefined) ?? 0.01;
    const current = (value as number | null | undefined) ?? min;
    return (
      <FieldRow label={label} description={description} optional={isOptional} alignTop meta={meta}>
        <div className="space-y-1.5">
          <div className="flex gap-2 items-center">
            <Slider
              min={min}
              max={max}
              step={step}
              value={[current]}
              onValueChange={([v]) => onChange(v)}
              disabled={disabled}
              className="flex-1"
            />
            <Input
              type="number"
              value={current}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v)) onChange(clamp(v, min, max));
              }}
              min={min}
              max={max}
              step={step}
              disabled={disabled}
              className="w-20 text-right tabular-nums shrink-0"
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground px-0.5">
            <span>{min}</span>
            <span>{max}</span>
          </div>
        </div>
      </FieldRow>
    );
  }

  // String/number with enum → Select
  if (schema.enum != null && Array.isArray(schema.enum)) {
    const options = schema.enum as unknown[];
    return (
      <FieldRow label={label} description={description} optional={isOptional} meta={meta}>
        <Select
          value={value != null ? String(value) : ""}
          onValueChange={(v) => {
            if (schema.type === "number" || schema.type === "integer") {
              onChange(Number(v));
            } else {
              onChange(v);
            }
          }}
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={String(o)} value={String(o)}>
                {String(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
    );
  }

  // String const
  if (schema.const != null) {
    return (
      <FieldRow label={label} description={description} meta={meta}>
        <Input value={String(schema.const)} disabled readOnly />
      </FieldRow>
    );
  }

  // Default: Input
  const inputType =
    schema.type === "number" || schema.type === "integer" ? "number" : "text";
  return (
    <FieldRow label={label} description={description} optional={isOptional} meta={meta}>
      <Input
        type={inputType}
        value={value != null ? String(value) : ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (schema.type === "number" || schema.type === "integer") {
            onChange(raw === "" ? null : Number(raw));
          } else {
            onChange(raw);
          }
        }}
        disabled={disabled}
        placeholder={schema.default != null ? String(schema.default) : undefined}
      />
    </FieldRow>
  );
}

function ObjectField({
  label,
  description,
  schema,
  rootSchema,
  uiSchema,
  value,
  onChange,
  disabled,
  depth,
  mode,
  optional,
}: {
  label: string;
  description?: string;
  schema: Schema;
  rootSchema: Schema;
  uiSchema?: Record<string, unknown>;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  depth: number;
  mode: "edit" | "readonly";
  optional: boolean;
}) {
  const [open, setOpen] = useState(mode === "readonly" ? depth < 3 : depth < 2);
  const objValue = (value as Record<string, unknown> | null | undefined) ?? {};
  const properties = schema.properties as Record<string, Schema> | undefined;
  const requiredFields = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  );

  if (!properties) return null;

  function handleChange(key: string, v: unknown) {
    onChange({ ...objValue, [key]: v });
  }

  return (
    <div className={cn("py-2", depth > 0 && "ml-2 border-l border-border/70 pl-4")}>
      <button
        type="button"
        className="flex w-full items-center justify-between py-2 text-left text-sm font-medium transition-colors hover:text-primary"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          {depth > 0 && (
            <span className="text-xs text-muted-foreground font-mono">{"{ }"}</span>
          )}
          <span>{label}</span>
          {optional && (
            <span className="text-xs font-normal text-muted-foreground">(optional)</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {!open && (
            <span className="text-xs text-muted-foreground font-mono">
              {Object.keys(properties).length} fields
            </span>
          )}
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
      </button>
      {description && !open && (
        <p className="pb-2 text-xs text-muted-foreground">{description}</p>
      )}
      {open && (
        <div className="pb-2">
          {description && (
            <p className="text-xs text-muted-foreground mb-2">{description}</p>
          )}
          <div className="divide-y divide-border/50">
            {Object.entries(properties).map(([key, propSchema]) => (
              <Field
                key={key}
                fieldKey={key}
                schema={propSchema}
                rootSchema={rootSchema}
                uiSchema={uiSchema}
                value={objValue[key]}
                onChange={(v) => handleChange(key, v)}
                disabled={disabled}
                depth={depth + 1}
                mode={mode}
                required={requiredFields.has(key)}
              />
            ))}
            {Object.keys(properties).length === 0 && (
              <p className="text-xs text-muted-foreground py-2">No fields</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ModuleRefField({
  label,
  description,
  options,
  rootSchema,
  uiSchema,
  value,
  onChange,
  disabled,
  depth,
  optional,
  mode,
}: {
  label: string;
  description?: string;
  options: Schema[];
  rootSchema: Schema;
  uiSchema?: Record<string, unknown>;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  depth: number;
  optional: boolean;
  mode: "edit" | "readonly";
}) {
  const objValue = (value as Record<string, unknown> | null | undefined) ?? {};
  const currentType = (objValue.__module__ ?? objValue.__type__ ?? objValue.type ?? objValue._type) as
    | string
    | undefined;

  const moduleNames = options
    .map((o) => (o.title as string | undefined) ?? "")
    .filter(Boolean);

  const selectedName = currentType ?? (mode === "edit" ? moduleNames[0] || "" : "");
  const selectedSchema = options.find(
    (o) => o.title === selectedName || o.title === currentType
  );

  function selectModule(name: string) {
    const schema = options.find((o) => o.title === name);
    if (!schema) return;
    const defaults: Record<string, unknown> = { __module__: name };
    if (schema.properties) {
      for (const [k, v] of Object.entries(
        schema.properties as Record<string, Schema>
      )) {
        if (v.default !== undefined) defaults[k] = v.default;
      }
    }
    onChange(defaults);
  }

  return (
    <div className="py-1">
      <FieldRow label={label} description={description} optional={optional}>
        {mode === "readonly" ? (
          <ReadonlyValue value={selectedName || undefined} />
        ) : (
          <Select
            value={selectedName}
            onValueChange={selectModule}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select module..." />
            </SelectTrigger>
            <SelectContent>
              {moduleNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FieldRow>
      {selectedSchema && selectedSchema.properties != null && (
        <ObjectField
          label={`${selectedName} config`}
          schema={selectedSchema}
          rootSchema={rootSchema}
          uiSchema={uiSchema}
          value={objValue}
          onChange={(v) =>
            onChange({ ...(v as Record<string, unknown>), __module__: selectedName })
          }
          disabled={disabled}
          depth={depth + 1}
          mode={mode}
          optional={false}
        />
      )}
    </div>
  );
}

export function ConfigForm({
  schema,
  uiSchema,
  values,
  onChange,
  disabled,
  mode = "edit",
  title,
  description,
}: ConfigFormProps) {
  const properties = schema.properties as Record<string, Schema> | undefined;
  const requiredFields = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : []
  );

  if (!properties) {
    return (
      <p className="text-sm text-muted-foreground">
        No configurable parameters.
      </p>
    );
  }

  function handleChange(key: string, v: unknown) {
    onChange({ ...values, [key]: v });
  }

  return (
    <div className="space-y-4">
      {(title || description) && (
        <div>
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {description && (
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
      <div className="divide-y divide-border/50 border-t border-border/70">
        {Object.entries(properties).map(([key, propSchema]) => (
          <Field
            key={key}
            fieldKey={key}
            schema={propSchema as Schema}
            rootSchema={schema}
            uiSchema={uiSchema}
            value={values[key]}
            onChange={(v) => handleChange(key, v)}
            disabled={disabled || mode === "readonly"}
            depth={0}
            mode={mode}
            required={requiredFields.has(key)}
          />
        ))}
      </div>
    </div>
  );
}
