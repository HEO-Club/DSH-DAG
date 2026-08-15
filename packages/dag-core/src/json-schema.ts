/**
 * Minimal JSON Schema (draft-07 subset) validator.
 *
 * Framework-free stand-in for the Python `jsonschema` library used by the
 * Router's `NodeResultValidator`. Supports the keywords exercised by the
 * Router test scenarios and the plugin's `expectedOutputSchema` contract:
 * type / enum / const / required / properties / additionalProperties / items /
 * minItems / maxItems / uniqueItems / minLength / maxLength / pattern /
 * minimum / maximum / exclusiveMinimum / exclusiveMaximum / multipleOf /
 * allOf / anyOf / oneOf / not.
 *
 * `$ref` and remote references are NOT supported; schemas must be inline.
 */

export interface SchemaError {
  message: string
  /** JSON path of the offending value, e.g. ['items', 0, 'name']. */
  path: Array<string | number>
}

function describePath(path: Array<string | number>): string {
  if (path.length === 0) return '(root)'
  return path.map((part) => (typeof part === 'number' ? `[${part}]` : `'${part}'`)).join('.')
}

export function validateJsonSchema(
  instance: unknown,
  schema: Record<string, unknown>,
  path: Array<string | number> = [],
): SchemaError | null {
  const keywords = schema as Record<string, unknown>

  // Type check
  if (keywords.type !== undefined) {
    const expected = keywords.type as string
    if (expected !== jsonTypeOf(instance)) {
      return {
        message: `${describePath(path)}: expected ${expected}, got ${jsonTypeOf(instance)}`,
        path: [...path],
      }
    }
  }

  if (keywords.enum !== undefined && Array.isArray(keywords.enum)) {
    if (!keywords.enum.some((item) => deepEqual(item, instance))) {
      return {
        message: `${describePath(path)}: value is not one of the allowed enum values`,
        path: [...path],
      }
    }
  }

  if (keywords.const !== undefined) {
    if (!deepEqual(keywords.const, instance)) {
      return {
        message: `${describePath(path)}: value does not match const`,
        path: [...path],
      }
    }
  }

  if (keywords.allOf !== undefined && Array.isArray(keywords.allOf)) {
    for (const sub of keywords.allOf) {
      const error = validateJsonSchema(instance, sub as Record<string, unknown>, path)
      if (error !== null) return error
    }
  }

  if (keywords.anyOf !== undefined && Array.isArray(keywords.anyOf)) {
    const ok = keywords.anyOf.some((sub) => validateJsonSchema(instance, sub as Record<string, unknown>, path) === null)
    if (!ok) {
      return { message: `${describePath(path)}: value does not match any allowed schema`, path: [...path] }
    }
  }

  if (keywords.oneOf !== undefined && Array.isArray(keywords.oneOf)) {
    const matches = keywords.oneOf.filter((sub) => validateJsonSchema(instance, sub as Record<string, unknown>, path) === null).length
    if (matches !== 1) {
      return { message: `${describePath(path)}: value matches ${matches} schemas, expected exactly 1`, path: [...path] }
    }
  }

  if (keywords.not !== undefined) {
    if (validateJsonSchema(instance, keywords.not as Record<string, unknown>, path) === null) {
      return { message: `${describePath(path)}: value must not match the 'not' schema`, path: [...path] }
    }
  }

  if (typeof instance === 'string') {
    if (keywords.minLength !== undefined && (instance as string).length < (keywords.minLength as number)) {
      return { message: `${describePath(path)}: string is shorter than minimum length ${keywords.minLength}`, path: [...path] }
    }
    if (keywords.maxLength !== undefined && (instance as string).length > (keywords.maxLength as number)) {
      return { message: `${describePath(path)}: string is longer than maximum length ${keywords.maxLength}`, path: [...path] }
    }
    if (keywords.pattern !== undefined) {
      const re = new RegExp(keywords.pattern as string)
      if (!re.test(instance as string)) {
        return { message: `${describePath(path)}: string does not match pattern '${keywords.pattern}'`, path: [...path] }
      }
    }
  }

  if (typeof instance === 'number') {
    const value = instance as number
    if (keywords.minimum !== undefined && value < (keywords.minimum as number)) {
      return { message: `${describePath(path)}: ${value} is less than minimum ${keywords.minimum}`, path: [...path] }
    }
    if (keywords.maximum !== undefined && value > (keywords.maximum as number)) {
      return { message: `${describePath(path)}: ${value} is greater than maximum ${keywords.maximum}`, path: [...path] }
    }
    if (keywords.exclusiveMinimum !== undefined && value <= (keywords.exclusiveMinimum as number)) {
      return { message: `${describePath(path)}: ${value} must be greater than ${keywords.exclusiveMinimum}`, path: [...path] }
    }
    if (keywords.exclusiveMaximum !== undefined && value >= (keywords.exclusiveMaximum as number)) {
      return { message: `${describePath(path)}: ${value} must be less than ${keywords.exclusiveMaximum}`, path: [...path] }
    }
    if (keywords.multipleOf !== undefined) {
      const divisor = keywords.multipleOf as number
      if (divisor > 0 && value / divisor !== Math.round(value / divisor)) {
        return { message: `${describePath(path)}: ${value} is not a multiple of ${divisor}`, path: [...path] }
      }
    }
  }

  if (Array.isArray(instance)) {
    if (keywords.minItems !== undefined && instance.length < (keywords.minItems as number)) {
      return { message: `${describePath(path)}: array has fewer than ${keywords.minItems} items`, path: [...path] }
    }
    if (keywords.maxItems !== undefined && instance.length > (keywords.maxItems as number)) {
      return { message: `${describePath(path)}: array has more than ${keywords.maxItems} items`, path: [...path] }
    }
    if (keywords.uniqueItems === true) {
      for (let i = 0; i < instance.length; i += 1) {
        for (let j = i + 1; j < instance.length; j += 1) {
          if (deepEqual(instance[i], instance[j])) {
            return { message: `${describePath(path)}: array items must be unique`, path: [...path, i] }
          }
        }
      }
    }
    if (keywords.items !== undefined) {
      const items = keywords.items as Record<string, unknown> | Record<string, unknown>[]
      if (Array.isArray(items)) {
        for (let i = 0; i < Math.min(instance.length, items.length); i += 1) {
          const error = validateJsonSchema(instance[i], items[i] as Record<string, unknown>, [...path, i])
          if (error !== null) return error
        }
      } else {
        for (let i = 0; i < instance.length; i += 1) {
          const error = validateJsonSchema(instance[i], items as Record<string, unknown>, [...path, i])
          if (error !== null) return error
        }
      }
    }
  }

  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    const record = instance as Record<string, unknown>
    const required = (keywords.required as string[] | undefined) ?? []
    for (const key of required) {
      if (!(key in record)) {
        return { message: `${describePath(path)}: missing required property '${key}'`, path: [...path, key] }
      }
    }
    if (keywords.properties !== undefined) {
      const properties = keywords.properties as Record<string, Record<string, unknown>>
      for (const [key, subSchema] of Object.entries(properties)) {
        if (key in record) {
          const error = validateJsonSchema(record[key], subSchema, [...path, key])
          if (error !== null) return error
        }
      }
    }
    if (keywords.additionalProperties !== undefined && keywords.additionalProperties !== true) {
      const known = new Set(Object.keys((keywords.properties as Record<string, unknown>) ?? {}))
      for (const [key, value] of Object.entries(record)) {
        if (known.has(key)) continue
        if (keywords.additionalProperties === false) {
          return { message: `${describePath(path)}: additional property '${key}' is not allowed`, path: [...path, key] }
        }
        const error = validateJsonSchema(value, keywords.additionalProperties as Record<string, unknown>, [...path, key])
        if (error !== null) return error
      }
    }
  }

  return null
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number'
  }
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>)
    const bKeys = Object.keys(b as Record<string, unknown>)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  }
  return false
}
