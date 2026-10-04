export type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue }
export interface PlanNode {
  type: string
  props: Record<string, WireValue>
  children: PlanNode[]
}
export interface Build123dPlan { version: 1; children: PlanNode[] }
export interface MeshData {
  positions: number[]
  normals: number[]
  indices: number[]
  edges: number[][]
  vertices?: number[]
  color?: string | number[]
  name?: string
  /** Native assembly ancestry; all mesh coordinates are already in world space. */
  assemblyPath?: { name: string; index: number }[]
  volume: number
  area: number
  valid: boolean
  kind: string
}
export interface RenderResult {
  meshes: MeshData[]
  bounds: { min: number[]; max: number[] } | null
  kernel: string
}
export interface RenderOptions { tolerance?: number; angularTolerance?: number; signal?: AbortSignal }
