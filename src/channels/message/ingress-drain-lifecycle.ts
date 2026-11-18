import type { ChannelIngressQueueRecord } from "./ingress-queue.types.js";

/** Full pre-adoption -> adoption ownership lifecycle for one claimed event. */
export type ChannelIngressDispatchLifecycle = {
  /** The durable claim was previously released before turn adoption. */
  retryAbandonedInput?: true;
  /** Pre-adoption only. After adopt the drain treats this signal as inert. */
  abortSignal: AbortSignal;
  /**
   * Same-lane rows admitted but not yet handed off, excluding this event.
   * Lets channel buffers that span lane rows wait for input that is already durable.
   */
  readLaneBacklog?: () => Promise<readonly ChannelIngressQueueRecord<unknown>[]>;
  /**
   * Fires when recovery-relevant session/run state is durable.
   * Drain completes (tombstones) the claim here -- never at settle.
   */
  onAdopted: () => void | Promise<void>;
  /**
   * Turn ownership deferred to reply-lane admission (queued followup).
   * Claim remains held until adopted or abandoned.
   */
  onDeferred: () => void;
  /** Pre-adoption liveness while waiting for reply-lane admission or preflight compaction. */
  onDeferredHeartbeat?: () => void;
  deferredHeartbeatIntervalMs?: number;
  /**
   * Durable adoption finalization is in progress (e.g. settlement hold while
   * committing dedupe). Clears the pre-adoption stall watchdog so a timeout
   * settlement cannot race and dead-letter an about-to-complete claim.
   * Claim stays held until onAdopted / onAbandoned / fail.
   */
  onAdoptionFinalizing: () => void;
  /** Deferred work terminally failed after dispatch returned. */
  onFailed?: (error: unknown) => void | Promise<void>;
  /** Explicit cancellation before adoption; releases without consuming retry budget. */
  onCancelled?: () => void | Promise<void>;
  /**
   * Deferred turn finished without ever owning the reply lane.
   * Drain releases the claim for retry.
   */
  onAbandoned: () => void | Promise<void>;
};

const ABANDONED_TURN = "turn-abandoned";

/** Carry prior abandonment into reply admission and preserve the queue disposition for the next claim. */
export function bindIngressRetryDisposition(
  claim: Pick<ChannelIngressQueueRecord<unknown>, "lastError">,
  release: (options: { lastError?: string; recordAttempt?: boolean }) => Promise<void>,
): Pick<ChannelIngressDispatchLifecycle, "retryAbandonedInput" | "onCancelled" | "onAbandoned"> {
  return {
    retryAbandonedInput: claim.lastError === ABANDONED_TURN ? true : undefined,
    // Cancellation releases the claim for replacement without modifying its prior retry facts.
    onCancelled: () => release({ recordAttempt: false }),
    onAbandoned: () => release({ lastError: ABANDONED_TURN }),
  };
}

/** Maps a drain lifecycle onto the reply-lane ownership surface. */
export function bindIngressLifecycleToReplyOptions(lifecycle: ChannelIngressDispatchLifecycle): {
  turnAdoptionLifecycle: Omit<
    ChannelIngressDispatchLifecycle,
    "onAdoptionFinalizing" | "onFailed" | "onCancelled" | "readLaneBacklog"
  > & { admission: "exclusive" };
} {
  return {
    turnAdoptionLifecycle: {
      admission: "exclusive",
      retryAbandonedInput: lifecycle.retryAbandonedInput,
      onAdopted: lifecycle.onAdopted,
      onDeferred: lifecycle.onDeferred,
      onDeferredHeartbeat: lifecycle.onDeferredHeartbeat,
      deferredHeartbeatIntervalMs: lifecycle.deferredHeartbeatIntervalMs,
      onAbandoned: lifecycle.onAbandoned,
      abortSignal: lifecycle.abortSignal,
    },
  };
}

// onAdoptionFinalizing stays drain-only (not reply-options); channels call it
// via the spooled-replay ALS lifecycle frame during settlement hold.
