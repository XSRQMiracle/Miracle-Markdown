/**
 * Transactional configuration for the MathJax runtime.
 *
 * The browser component is a singleton, while rebuilding its TeX input jax
 * mutates that singleton in place.  This small, DOM-free coordinator gives the
 * bridge the properties that mutation alone does not have: request-time
 * snapshots, serial transitions, and restoration of the last committed
 * configuration after a failed transition.
 */

export interface MathOptions {
  /** The LaTeX `physics` package. */
  physics: boolean;
  /** mhchem, for chemical equations written as \\ce{...}. */
  mhchem: boolean;
  /** braket notation: \\bra, \\ket, \\braket. */
  braket: boolean;
  /** mathtools, extending amsmath. */
  mathtools: boolean;
  /** Document-level macro definitions, as \\newcommand would give them. */
  macros: Record<string, string | [string, number]>;
}

export const DEFAULT_MATH_OPTIONS: MathOptions = {
  physics: false,
  mhchem: false,
  braket: false,
  mathtools: true,
  macros: {},
};

export interface ConfigurationSnapshot<T> {
  /** Stable identity used to coalesce requests that configure the same state. */
  key: string;
  /** A value detached from the mutable object supplied by the caller. */
  value: T;
}

/**
 * Take an immutable, deterministic snapshot at the point a request is made.
 * Sorting macro names also makes otherwise equivalent objects share a key.
 */
export function snapshotMathOptions(options: MathOptions): ConfigurationSnapshot<MathOptions> {
  const macros: Record<string, string | [string, number]> = {};
  for (const name of Object.keys(options.macros).sort()) {
    const definition = options.macros[name];
    macros[name] = Array.isArray(definition)
      ? Object.freeze([definition[0], definition[1]]) as [string, number]
      : definition;
  }
  Object.freeze(macros);

  const value = Object.freeze({
    physics: options.physics,
    mhchem: options.mhchem,
    braket: options.braket,
    mathtools: options.mathtools,
    macros,
  }) as MathOptions;
  return Object.freeze({ key: JSON.stringify(value), value });
}

export class ConfigurationRecoveryError extends Error {
  readonly transitionError: unknown;
  readonly recoveryError: unknown;

  constructor(transitionError: unknown, recoveryError: unknown) {
    const detail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
    super(`Configuration failed and the previous configuration could not be restored: ${detail}`);
    this.name = "ConfigurationRecoveryError";
    this.transitionError = transitionError;
    this.recoveryError = recoveryError;
  }
}

interface ConfigurationLifecycleOptions<TInput, TConfiguration> {
  snapshot(input: TInput): ConfigurationSnapshot<TConfiguration>;
  apply(configuration: TConfiguration): void | Promise<void>;
  /** Called synchronously after a configuration has become the committed one. */
  committed?(configuration: TConfiguration): void;
  /** Called when there is no longer a known-good runtime configuration. */
  broken?(): void;
}

/**
 * Serialize mutations of one runtime and make each one transactional.
 *
 * A rejected operation is converted to a fulfilled queue tail, so one bad
 * configuration never poisons later requests.  The individual caller still
 * receives the original rejection.
 */
export class ConfigurationLifecycle<TInput, TConfiguration> {
  private current: ConfigurationSnapshot<TConfiguration> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private options: ConfigurationLifecycleOptions<TInput, TConfiguration>) {}

  configure(input: TInput): Promise<boolean> {
    // This deliberately happens before joining the queue.  Callers keep and
    // mutate one options object, so taking the snapshot inside `transition`
    // would make an earlier queued request silently become a later one.
    const wanted = this.options.snapshot(input);
    const operation = this.tail.then(() => this.transition(wanted));
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async transition(wanted: ConfigurationSnapshot<TConfiguration>): Promise<boolean> {
    if (this.current?.key === wanted.key) return false;

    const previous = this.current;
    try {
      await this.options.apply(wanted.value);
    } catch (transitionError) {
      if (previous) {
        try {
          await this.options.apply(previous.value);
        } catch (recoveryError) {
          this.current = null;
          this.options.broken?.();
          throw new ConfigurationRecoveryError(transitionError, recoveryError);
        }
      } else {
        this.options.broken?.();
      }
      throw transitionError;
    }

    this.current = wanted;
    this.options.committed?.(wanted.value);
    return true;
  }
}
