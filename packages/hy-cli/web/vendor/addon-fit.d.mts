export class FitAddon {
  constructor()
  fit(): void
  proposeDimensions(): { cols: number; rows: number } | undefined
  dispose(): void
}
