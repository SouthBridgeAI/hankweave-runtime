# Ability to resume execution of failure/halting

This one’s really useful - and we’re almost all the way there. We already have checkpointing, rollbacks, and state for the phases. What we don’t have is hookup to perform a simple resume, where the server:

- Boots up
- Reads state
- Figures out the last valid checkpoint to resume from
- Rolls back to that
- Continues execution

Please, carefully analyze current architecture and come up with a detailed implementation plan to support execution resumption outlined above. Indicate changes to the modules and include relevant code snippets.
