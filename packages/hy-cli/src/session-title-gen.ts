/**
 * WP-60: a generated chat name (DSH's `dsh-session-title`).
 *
 * The model proposes a name; a deterministic heuristic is the fallback so a
 * title always exists (offline, a broken provider, `--mock`). Generation is
 * always an explicit action: no turn asks for a title on its own.
 */
import { createProvider, type HarnessConfig, type LlmProvider } from '../../core/dist/index.js'
import { buildTitleMessages, cleanGeneratedTitle, titleFromFirstMessage } from './session-title.js'

export interface TitleInput {
  /** The first user message of the session. */
  first: string
  /** Every user message, when generating from the whole conversation. */
  userMessages?: readonly string[]
}

export interface GeneratedSessionTitle {
  title: string
  /** `llm` when the model answered, `heuristic` for the fallback. */
  source: 'llm' | 'heuristic'
  /** Why the fallback was used, for the API and the log. */
  reason?: string
}

/** Joins the request: the opening messages matter most, the last ones give context. */
export function titleRequestText(input: TitleInput): string {
  const messages = (input.userMessages ?? []).map((message) => message.trim()).filter(Boolean)
  if (messages.length <= 1) return input.first.trim()
  const head = messages.slice(0, 2)
  const tail = messages.slice(-3)
  const unique = [...new Set([...head, ...tail])]
  return unique.map((message, index) => `#${index + 1}\n${message.slice(0, 1_500)}`).join('\n\n').slice(0, 4_000)
}

export interface GenerateTitleOptions {
  /** Injected in tests (a fake provider). */
  provider?: LlmProvider
  signal?: AbortSignal
  /** A slow provider must never delay the GUI; the heuristic wins after this. */
  timeoutMs?: number
}

/** Rejects after `ms` even when the provider ignores its abort signal. */
function withTimeout<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`the provider did not answer within ${ms} ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Asks the worker role for a name and falls back to the user's first line.
 * Never throws: a title generation failure is not an error the user can act on.
 */
export async function generateSessionTitle(
  config: HarnessConfig,
  input: TitleInput,
  options: GenerateTitleOptions = {},
): Promise<GeneratedSessionTitle> {
  const heuristic = titleFromFirstMessage(input.first)
  const request = titleRequestText(input)
  if (!request.trim()) return { title: heuristic, source: 'heuristic', reason: 'empty request' }
  if (config.role.provider === 'mock' && options.provider === undefined) {
    return { title: heuristic, source: 'heuristic', reason: 'mock provider' }
  }
  const provider = options.provider ?? createProvider(config.role, config.workspaceRoot)
  const effort =
    config.role.effort ?? (config.role.provider === 'opencode' ? 'none' : undefined)
  const timeoutMs = options.timeoutMs ?? 20_000
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort)
  try {
    // The race is the real guarantee: a provider that ignores the abort signal
    // (or one call that never settles) must not hold the request open.
    const completion = await withTimeout(
      provider.complete(buildTitleMessages({ request }), {
        maxTokens: 48,
        temperature: 0,
        json: false,
        // A reasoning phase can spend the whole 48-token budget before the title.
        ...(effort ? { effort } : {}),
        signal: controller.signal,
      }),
      timeoutMs,
      controller,
    )
    const title = cleanGeneratedTitle(completion.content)
    if (!title) return { title: heuristic, source: 'heuristic', reason: 'the model returned no usable title' }
    return { title, source: 'llm' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { title: heuristic, source: 'heuristic', reason }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}
