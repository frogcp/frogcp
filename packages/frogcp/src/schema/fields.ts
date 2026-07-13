import type { FieldDef, FieldType } from "./types";

export class FieldBuilder {
  constructor(private def: FieldDef) {}
  required(): this { this.def = { ...this.def, required: true }; return this; }
  default(v: unknown): this { this.def = { ...this.def, default: v }; return this; }
  auto(): this {
    if (this.def.type !== "timestamp") throw new Error(".auto() is only valid on timestamp()");
    this.def = { ...this.def, auto: true }; return this;
  }
  onDelete(mode: "cascade" | "set null" | "restrict"): this {
    if (this.def.type !== "ref") throw new Error(".onDelete() is only valid on ref()");
    this.def = { ...this.def, onDelete: mode }; return this;
  }
  unique(): this { this.def = { ...this.def, unique: true }; return this; }
  hidden(): this { this.def = { ...this.def, hidden: true }; return this; }
  readonly(): this { this.def = { ...this.def, readonly: true }; return this; }
  build(): FieldDef {
    // strip undefined keys so deep-equality tests stay exact
    return Object.fromEntries(Object.entries(this.def).filter(([, v]) => v !== undefined)) as FieldDef;
  }
}

const make = (type: FieldType) => new FieldBuilder({ type, required: false });
export const text = () => make("text");
export const number = () => make("number");
export const boolean = () => make("boolean");
export const date = () => make("date");
export const timestamp = () => make("timestamp");
export const json = () => make("json");
/**
 * Stores a storage-key string pointing at bytes in the configured
 * `StorageAdapter`, never the bytes themselves. The column is plain text; the
 * `frogcp/media` plugin handles upload and serving by that key.
 */
export const media = () => make("media");
export const select = (options: readonly string[]) => {
  if (!options?.length) throw new Error("select() requires options");
  return new FieldBuilder({ type: "select", required: false, options });
};
export const ref = (target: string) => new FieldBuilder({ type: "ref", required: false, target });
