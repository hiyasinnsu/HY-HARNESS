export interface IDisposable {
  dispose(): void
}

export interface ITerminalSize {
  cols: number
  rows: number
}

export class Terminal {
  cols: number
  rows: number
  constructor(options?: Record<string, unknown>)
  open(parent: HTMLElement): void
  write(data: string | Uint8Array): void
  clear(): void
  reset(): void
  dispose(): void
  focus(): void
  loadAddon(addon: unknown): void
  onData(listener: (data: string) => void): IDisposable
  onResize(listener: (size: ITerminalSize) => void): IDisposable
  resize(cols: number, rows: number): void
}
