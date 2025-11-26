### Research on Looping Phases Feature

This document addresses the impact of the proposed looping phases feature on checkpoints and error handling, based on the design outlined in `@intermediates/18-looping-phases/2-gemini.md`.

#### 1. Impact on Checkpoints

The introduction of looping phases primarily affects how the application's execution state is managed, which has a direct impact on the reliability of checkpoints. The existing checkpoint system, which appears to use a shadow git repository to version files, is fundamentally sound, but the data it saves must be updated.

The key considerations are:

*   **State Serialization**: The design proposes adding a `loopContext` to the `PhaseExecution` state to track the current iteration of a loop. It is **critical** that this `loopContext` is included in the application state that is serialized and saved as part of a checkpoint. When the system restores from a checkpoint, it must be able to reconstruct the exact state of the loop, including which iteration it was on and which phase was next. Without this, the execution flow would break upon restoration.
*   **Backward Compatibility**: The design correctly suggests making the `loopContext` an optional field (`loopContext?: LoopContext`). This is important for backward compatibility. When restoring older checkpoints created before the looping feature was introduced, the state loading mechanism should handle the absence of `loopContext` gracefully.
*   **`findContinuationSessionId`**: The design document mentions that `findContinuationSessionId` needs to be updated. This is also critical for checkpoints. When restoring a state mid-loop, and the next phase uses `continue-previous`, this function must be able to correctly identify the last phase of the previous iteration as the predecessor, even across a checkpoint restoration. This depends on the `loopContext` being correctly restored.

In summary, the current checkpointing mechanism (`CheckpointGit`) should work correctly with the new feature, **provided that the application state being checkpointed is properly extended to include the full loop execution context.**

#### 2. Error Handling for Looping Phases

The design document does not specify error handling within loops. If a phase inside a loop fails, the system needs a clear and predictable behavior.

The recommended approach is to **halt the entire execution upon failure**, which is consistent with how failures in non-looping phases are likely handled.

*   **Behavior**: If a phase within a loop (e.g., the "write-code" phase in iteration 2 of 3) fails, the execution of the entire sequence of phases should be paused. The system should not automatically skip to the next phase or the next iteration, as this could lead to an inconsistent and unpredictable state.
*   **State on Failure**: The application state must clearly indicate which phase failed and within which loop context (i.e., `loopId` and `iteration`). This gives the user the necessary information to diagnose the problem.
*   **Resumption**: After a failure, the system should allow the user to intervene. Once the underlying issue is fixed (e.g., a prompt is corrected, or a file is manually edited), the user should be able to resume the execution. The `ExecutionThread` must be able to restart the *failed* phase within its original loop context.

This error handling strategy prioritizes stability and predictability, giving the user control over resolving issues that occur within a loop.
