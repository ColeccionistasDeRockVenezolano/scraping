export type FieldValue = string | number | boolean | null | undefined;

export type FieldConfig =
  | { key: string; label: string; type: "text" | "url" | "date"; required?: boolean; span2?: boolean; hint?: string }
  | { key: string; label: string; type: "number"; required?: boolean; hint?: string }
  | { key: string; label: string; type: "textarea"; required?: boolean; span2?: boolean; hint?: string }
  | { key: string; label: string; type: "select"; required?: boolean; options: ReadonlyArray<{ value: string; label: string }>; allowEmpty?: boolean; hint?: string }
  | { key: string; label: string; type: "checkbox"; hint?: string };

interface FormFieldsProps {
  fields: readonly FieldConfig[];
  values: Record<string, FieldValue>;
  onChange: (key: string, value: FieldValue) => void;
  errors?: Record<string, string>;
}

export function FormFields({ fields, values, onChange, errors }: FormFieldsProps) {
  return (
    <div className="form-grid">
      {fields.map((field) => {
        const value = values[field.key];
        const error = errors?.[field.key];
        const spanClass = "span2" in field && field.span2 ? "field span-2" : "field";

        if (field.type === "checkbox") {
          return (
            <div className={`${spanClass} checkbox-field`} key={field.key}>
              <input
                id={`f-${field.key}`} type="checkbox" checked={Boolean(value)}
                onChange={(event) => onChange(field.key, event.target.checked)}
              />
              <label htmlFor={`f-${field.key}`}>{field.label}</label>
            </div>
          );
        }

        return (
          <div className={`${spanClass} ${error ? "has-error" : ""}`} key={field.key}>
            <label htmlFor={`f-${field.key}`}>{field.label}{field.required ? " *" : ""}</label>
            {field.type === "textarea" ? (
              <textarea id={`f-${field.key}`} value={(value as string) ?? ""} onChange={(event) => onChange(field.key, event.target.value)} />
            ) : field.type === "select" ? (
              <select id={`f-${field.key}`} value={(value as string) ?? ""} onChange={(event) => onChange(field.key, event.target.value || null)}>
                {field.allowEmpty || !field.required ? <option value="">—</option> : null}
                {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : field.type === "number" ? (
              <input
                id={`f-${field.key}`} type="number" value={value === null || value === undefined ? "" : String(value)}
                onChange={(event) => onChange(field.key, event.target.value === "" ? null : Number(event.target.value))}
              />
            ) : (
              <input
                id={`f-${field.key}`} type={field.type === "url" ? "url" : field.type === "date" ? "date" : "text"}
                value={(value as string) ?? ""} onChange={(event) => onChange(field.key, event.target.value)}
              />
            )}
            {field.hint ? <span className="hint">{field.hint}</span> : null}
            {error ? <span className="error">{error}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
