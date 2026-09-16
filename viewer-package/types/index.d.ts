export * from './viewer'
export { default } from './viewer'
export * from './toolpath'
export const log: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void }
export function effectiveSettings(settings: Record<string, unknown>, plateSettings: Record<string, unknown>, plate: number): Record<string, unknown>
export function plateTechnology(settings: Record<string, unknown>, plateSettings: Record<string, unknown>, plate: number): 'FFF' | 'SLA'
export function statsFromKernel(stats: Record<string, unknown>, throughput?: unknown): Record<string, unknown>
