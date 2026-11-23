const scalarTypes = ['string', 'number', 'integer', 'boolean'] as const
type ScalarType = typeof scalarTypes[number]
type ScalarValue = string | number | boolean | null
type JsonObject = Record<string, unknown>

export type McpArgumentField = {
  name: string
  title: string
  description: string
  required: boolean
  sensitive: boolean
} & ({ type: ScalarType } | { type: 'enum'; options: ScalarValue[] })

export type McpArgumentInputs = Record<string, string | undefined>

type ArgumentProblem = { kind: 'json' | 'object' | 'number' } | {
  kind: 'required' | 'type' | 'enum' | 'extra'
  field: string
}
type ParsedArguments = { args: JsonObject; issue?: undefined } | { issue: ArgumentProblem; args?: undefined }

const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined

const label = (value: unknown) => typeof value === 'string' ? value : ''
const isUsableNumber = (value: number) => Number.isFinite(value) &&
  (!Number.isInteger(value) || Number.isSafeInteger(value))
const isScalar = (value: unknown): value is ScalarValue => value === null ||
  typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && isUsableNumber(value))
const requiredFields = (schema: JsonObject): string[] => Array.isArray(schema.required)
  ? schema.required.filter((field): field is string => typeof field === 'string') : []

export const mcpArgumentFields = (schema: JsonObject): McpArgumentField[] | undefined => {
  const properties = schema.properties === undefined ? {} : object(schema.properties)
  const required = requiredFields(schema)
  if ((schema.type !== undefined && schema.type !== 'object') || !properties ||
      required.some((name) => !Object.hasOwn(properties, name)) ||
      (Object.keys(properties).length === 0 && typeof schema.minProperties === 'number' && schema.minProperties > 0) ||
      ['allOf', 'anyOf', 'oneOf', 'if', '$ref', 'patternProperties'].some((key) => Object.hasOwn(schema, key))) {
    return undefined
  }
  const fields: McpArgumentField[] = []
  for (const [name, property] of Object.entries(properties)) {
    const entry = object(property)
    if (!entry || ['allOf', 'anyOf', 'oneOf', '$ref'].some((key) => Object.hasOwn(entry, key))) {
      return undefined
    }
    const field = {
      name, title: label(entry.title) || name, description: label(entry.description),
      required: required.includes(name), sensitive: entry.format === 'password' || entry.writeOnly === true,
    }
    if (Array.isArray(entry.enum) && entry.enum.length > 0 && entry.enum.every(isScalar)) {
      fields.push({ ...field, type: 'enum', options: entry.enum })
    } else if (scalarTypes.some((type) => entry.type === type)) {
      fields.push({ ...field, type: entry.type as ScalarType })
    } else {
      return undefined
    }
  }
  return fields
}

export const formMcpArguments = (fields: McpArgumentField[], values: McpArgumentInputs): JsonObject =>
  Object.fromEntries(fields.flatMap((field) => {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined
    if (value === undefined) {return []}
    switch (field.type) {
      case 'enum': return [[field.name, field.options[Number(value)]]]
      case 'boolean': return [[field.name, value === 'true']]
      case 'number':
      case 'integer': return [[field.name, Number(value)]]
      case 'string': return [[field.name, value]]
    }
  }))

const matchesType = (value: unknown, type: string): boolean => {
  switch (type) {
    case 'null': return value === null
    case 'object': return object(value) !== undefined
    case 'array': return Array.isArray(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    default: return true
  }
}

export const inputMcpArguments = (fields: McpArgumentField[], args: JsonObject): McpArgumentInputs | undefined => {
  const inputs: [string, string][] = []
  for (const [name, value] of Object.entries(args)) {
    const field = fields.find((candidate) => candidate.name === name)
    if (!field) {return undefined}
    if (field.type === 'enum') {
      const option = field.options.findIndex((candidate) => candidate === value)
      if (option === -1) {return undefined}
      inputs.push([name, String(option)])
    } else {
      if (!matchesType(value, field.type)) {return undefined}
      inputs.push([name, String(value)])
    }
  }
  return Object.fromEntries(inputs)
}

export const checkMcpArguments = (schema: JsonObject, args: JsonObject): ParsedArguments => {
  const properties = object(schema.properties) ?? {}
  for (const field of requiredFields(schema)) {
    if (!Object.hasOwn(args, field)) {return { issue: { kind: 'required', field } }}
  }
  for (const [field, value] of Object.entries(args)) {
    if (typeof value === 'number' && !isUsableNumber(value)) {return { issue: { kind: 'number' } }}
    const property = Object.hasOwn(properties, field) ? object(properties[field]) : undefined
    const type = property?.type
    if (typeof type === 'string' && !matchesType(value, type)) {return { issue: { kind: 'type', field } }}
    if (Array.isArray(type) && !type.some((entry) => typeof entry === 'string' && matchesType(value, entry))) {
      return { issue: { kind: 'type', field } }
    }
    if (Array.isArray(property?.enum) && property.enum.every(isScalar) && !property.enum.some((entry) => entry === value)) {
      return { issue: { kind: 'enum', field } }
    }
    if (schema.additionalProperties === false && !schema.patternProperties && !Object.hasOwn(properties, field)) {
      return { issue: { kind: 'extra', field } }
    }
  }
  return { args }
}

export const parseMcpArguments = (text: string): ParsedArguments => {
  try {
    const args = object(JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === 'number' && !isUsableNumber(value)) {throw new RangeError('Unsupported number')}
      return value
    }))
    return args ? { args } : { issue: { kind: 'object' } }
  } catch (cause) {
    return { issue: { kind: cause instanceof RangeError ? 'number' : 'json' } }
  }
}
