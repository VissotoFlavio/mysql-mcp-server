export interface DdlInputSnapshotOptions {
  readonly maximumBytes: number;
  readonly maximumDepth: number;
  fail(code: 'invalid_payload' | 'payload_too_large' | 'sparse_array', path: string): never;
}

/** Snapshots ordinary JSON-shaped values without invoking accessors or serializers. */
class DdlInputSnapshot {
  private bytes = 0;
  private readonly active = new WeakSet<object>();

  constructor(private readonly options: DdlInputSnapshotOptions) {}

  private reserve(bytes: number, path: string): void {
    this.bytes += bytes;
    if (this.bytes > this.options.maximumBytes) this.options.fail('payload_too_large', path);
  }

  private string(value: string, path: string): void {
    this.reserve(1, path);
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d) this.reserve(2, path);
      else if (unit < 0x20) this.reserve(6, path);
      else if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
        this.reserve(4, path);
        index += 1;
      } else if (unit >= 0xd800 && unit <= 0xdfff) this.reserve(6, path);
      else this.reserve(unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3, path);
    }
    this.reserve(1, path);
  }

  private descriptor(value: object, key: PropertyKey, path: string): PropertyDescriptor & { value: unknown } {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) this.options.fail('invalid_payload', path);
    return descriptor as PropertyDescriptor & { value: unknown };
  }

  private arrayIndex(key: string): number | undefined {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key ? index : undefined;
  }

  snapshot(value: unknown, path = 'input', depth = 0): unknown {
    if (value === null) {
      this.reserve(4, path);
      return null;
    }
    if (typeof value === 'string') {
      this.string(value, path);
      return value;
    }
    if (typeof value === 'boolean') {
      this.reserve(value ? 4 : 5, path);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) this.options.fail('invalid_payload', path);
      this.reserve(Buffer.byteLength(JSON.stringify(value), 'utf8'), path);
      return value;
    }
    if (typeof value !== 'object' || depth >= this.options.maximumDepth || this.active.has(value)) this.options.fail('invalid_payload', path);
    this.active.add(value);
    try {
      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype || Object.hasOwn(Array.prototype, 'toJSON') || Object.hasOwn(Object.prototype, 'toJSON'))
          this.options.fail('invalid_payload', path);
        return this.array(value, path, depth);
      }
      if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(Object.prototype, 'toJSON'))
        this.options.fail('invalid_payload', path);
      return this.object(value, path, depth);
    } finally {
      this.active.delete(value);
    }
  }

  private object(value: object, path: string, depth: number): Readonly<Record<string, unknown>> {
    const output = Object.create(null) as Record<string, unknown>;
    this.reserve(1, path);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') this.options.fail('invalid_payload', path);
      if (count > 0) this.reserve(1, path);
      this.string(key, path);
      this.reserve(1, path);
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: this.snapshot(this.descriptor(value, key, path).value, path, depth + 1),
      });
      count += 1;
    }
    this.reserve(1, path);
    return Object.freeze(output);
  }

  private array(value: object, path: string, depth: number): readonly unknown[] {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    )
      this.options.fail('invalid_payload', path);
    const length = lengthDescriptor.value as number;
    if (
      Reflect.ownKeys(value).some(
        (key) => key !== 'length' && (typeof key !== 'string' || this.arrayIndex(key) === undefined || (this.arrayIndex(key) as number) >= length),
      )
    )
      this.options.fail('sparse_array', path);
    const output: unknown[] = [];
    this.reserve(1, path);
    for (let index = 0; index < length; index += 1) {
      if (index > 0) this.reserve(1, path);
      output.push(this.snapshot(this.descriptor(value, String(index), path).value, `${path}[${index}]`, depth + 1));
    }
    this.reserve(1, path);
    return Object.freeze(output);
  }
}

export function snapshotDdlInput(value: unknown, options: DdlInputSnapshotOptions): unknown {
  return new DdlInputSnapshot(options).snapshot(value);
}
