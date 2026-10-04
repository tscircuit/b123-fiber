import type { Build123dPlan, PlanNode, WireValue } from '../../lib/types'

const wrappers = new Set(['Union', 'Subtract', 'Intersect', 'Translate', 'Rotate', 'Group', 'Shape', 'Call'])
const types = (nodes: PlanNode[]): string[] => nodes.flatMap(node => [node.type, ...types(node.children)])
const valueSource = (value: WireValue): string => {
  if (Array.isArray(value)) return `[${value.map(valueSource).join(', ')}]`
  if (value && typeof value === 'object') {
    if (typeof value.$enum === 'string') return `b.${value.$enum}`
    if (typeof value.$type === 'string' && typeof value.path === 'string') return `b.${value.$type}.${value.path}`
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${valueSource(item)}`).join(', ')} }`
  }
  return JSON.stringify(value)
}
const jsxNode = (node: PlanNode, depth: number): string => {
  const indent = '  '.repeat(depth)
  const type = wrappers.has(node.type) ? node.type : `b.${node.type}`
  const props = Object.entries(node.props).map(([key, value]) => `${key === 'ref' ? 'id' : key}={${valueSource(value)}}`)
  const oneLine = `${indent}<${type}${props.length ? ` ${props.join(' ')}` : ''}`
  const start = oneLine.length < 100 ? oneLine : `${indent}<${type}\n${props.map(prop => `${indent}  ${prop}`).join('\n')}\n${indent}`
  if (!node.children.length) return `${start} />`
  return `${start}>\n${node.children.map(child => jsxNode(child, depth + 1)).join('\n')}\n${indent}</${type}>`
}

export function planToSource(plan: Build123dPlan): string {
  const extras = [...new Set(types(plan.children).filter(type => wrappers.has(type)))].sort()
  const imports = ['b', ...extras].join(', ')
  const single = plan.children.length === 1
  const nodes = plan.children.map(node => jsxNode(node, single ? 2 : 3)).join('\n')
  return `import { ${imports} } from '@tscircuit/b123-fiber'\n\nexport default function Example() {\n  return (\n${single ? nodes : `    <>\n${nodes}\n    </>`}\n  )\n}\n`
}

export interface PlanParameter {
  path: (string | number)[]
  label: string
  value: number | boolean | string
}
export function planParameters(plan: Build123dPlan): PlanParameter[] {
  const found: PlanParameter[] = []
  const visit = (node: PlanNode, path: (string | number)[], index: number) => {
    Object.entries(node.props).forEach(([key, value]) => {
      if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && ['color', 'txt', 'font', 'name'].includes(key))) {
        found.push({ path: [...path, 'props', key], label: `${node.type} ${index + 1} · ${key}`, value })
      }
    })
    node.children.forEach((child, childIndex) => visit(child, [...path, 'children', childIndex], childIndex))
  }
  plan.children.forEach((node, index) => visit(node, ['children', index], index))
  return found
}

export function changeParameter(plan: Build123dPlan, parameter: PlanParameter, value: PlanParameter['value']): Build123dPlan {
  const next = structuredClone(plan)
  let target: any = next
  parameter.path.slice(0, -1).forEach(key => { target = target[key] })
  target[parameter.path.at(-1)!] = value
  return next
}
