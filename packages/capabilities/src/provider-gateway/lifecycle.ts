import { CapabilityError } from "../errors.js";
import {
  PROVIDER_MAX_REQUESTS,
  PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS,
  PROVIDER_OPERATION_TIMEOUT_MS,
  type ProviderRequestBudget,
  type ProviderSemanticMappingDefinition
} from "./contracts.js";

type AbortReason = "caller" | "total-timeout" | "close";

export class ProviderOperationBudget implements ProviderRequestBudget {
  readonly #controller = new AbortController();
  readonly #now: () => number;
  readonly #deadlineAt: number;
  readonly #maxRequests: number;
  readonly #callerSignal: AbortSignal | undefined;
  readonly #onCallerAbort: (() => void) | undefined;
  readonly #totalTimer: ReturnType<typeof setTimeout>;
  #abortReason: AbortReason | null = null;
  #requests = 0;
  #closed = false;

  constructor(input: {
    signal?: AbortSignal;
    now?: () => number;
    maxRequests?: number;
  }) {
    this.#now = input.now ?? Date.now;
    this.#deadlineAt = this.#now() + PROVIDER_OPERATION_TIMEOUT_MS;
    const requestedMax = input.maxRequests ?? PROVIDER_MAX_REQUESTS;
    if (!Number.isSafeInteger(requestedMax) || requestedMax < 1 || requestedMax > PROVIDER_MAX_REQUESTS) {
      throw new CapabilityError(
        "PROVIDER_INPUT_INVALID",
        `Provider request budget must be between 1 and ${PROVIDER_MAX_REQUESTS}`
      );
    }
    this.#maxRequests = requestedMax;
    this.#callerSignal = input.signal;
    this.#onCallerAbort = input.signal === undefined
      ? undefined
      : () => this.#abort("caller");
    if (input.signal !== undefined) {
      input.signal.addEventListener("abort", this.#onCallerAbort!, { once: true });
      if (input.signal.aborted) this.#abort("caller");
    }
    this.#totalTimer = setTimeout(() => this.#abort("total-timeout"), PROVIDER_OPERATION_TIMEOUT_MS);
    this.#totalTimer.unref?.();
  }

  get signal(): AbortSignal {
    this.#refreshDeadline();
    return this.#controller.signal;
  }

  claimRequest(): void {
    this.#assertActive();
    if (this.#requests >= this.#maxRequests) {
      throw new CapabilityError("PROVIDER_REQUEST_FAILED", "Provider request budget is exhausted");
    }
    this.#requests += 1;
  }

  async withAttemptTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertActive();
    const attempt = new AbortController();
    let attemptTimedOut = false;
    let settled = false;

    const abortFromOperation = () => attempt.abort();
    this.#controller.signal.addEventListener("abort", abortFromOperation, { once: true });
    if (this.#controller.signal.aborted) attempt.abort();

    const attemptTimer = setTimeout(() => {
      attemptTimedOut = true;
      attempt.abort();
    }, PROVIDER_NETWORK_ATTEMPT_TIMEOUT_MS);
    attemptTimer.unref?.();

    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(attemptTimer);
        this.#controller.signal.removeEventListener("abort", abortFromOperation);
        attempt.signal.removeEventListener("abort", onAttemptAbort);
      };
      const finishResolve = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAttemptAbort = () => {
        if (attemptTimedOut) {
          finishReject(timeout("Provider network attempt timed out"));
          return;
        }
        finishReject(this.#abortError());
      };
      attempt.signal.addEventListener("abort", onAttemptAbort, { once: true });

      try {
        void run(attempt.signal).then(finishResolve, finishReject);
      } catch (error) {
        finishReject(error);
      }

      if (attempt.signal.aborted) onAttemptAbort();
    });
  }

  canRetry(mapping: ProviderSemanticMappingDefinition, attempt: number): boolean {
    this.#refreshDeadline();
    if (this.#closed || this.#controller.signal.aborted) return false;
    if (mapping.retry !== "one-idempotent-read" || mapping.effect !== "REMOTE_READ" || attempt !== 0) {
      return false;
    }
    const mappingLimit = Math.min(PROVIDER_MAX_REQUESTS, mapping.maxProviderRequests, this.#maxRequests);
    return this.#requests < mappingLimit;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#totalTimer);
    if (this.#callerSignal !== undefined && this.#onCallerAbort !== undefined) {
      this.#callerSignal.removeEventListener("abort", this.#onCallerAbort);
    }
    this.#abort("close");
  }

  #assertActive(): void {
    this.#refreshDeadline();
    if (this.#closed || this.#controller.signal.aborted) throw this.#abortError();
  }

  #refreshDeadline(): void {
    if (!this.#controller.signal.aborted && this.#now() >= this.#deadlineAt) {
      this.#abort("total-timeout");
    }
  }

  #abort(reason: AbortReason): void {
    if (this.#abortReason === null) this.#abortReason = reason;
    if (!this.#controller.signal.aborted) this.#controller.abort();
  }

  #abortError(): CapabilityError {
    if (this.#abortReason === "total-timeout") {
      return timeout("Provider operation exceeded its total deadline");
    }
    return new CapabilityError("PROVIDER_CANCELLED", "Provider operation was cancelled");
  }
}

function timeout(message: string): CapabilityError {
  return new CapabilityError("PROVIDER_TIMEOUT", message);
}
