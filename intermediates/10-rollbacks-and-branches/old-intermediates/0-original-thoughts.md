# Implementing a rollack and branching system

You're given the current full state of the server code (so you don't need to read it again). Below are thoughts and plans of a feature we want to implement.

## Things to think through

1. What kind of state needs to be implemented? Some thoughts are below.
   1. This is the first thing to implement and test extensively. The state system needs to be solid for any kind of branching, rollback, etc to exist.It should be good enough to traverse, and hold enough state to do further rollbacks, resumes, etc. What are the best ways to implement this? Just a json file? Does this file get deleted with the cleanup?
2. What kind of operations do we support?
   1. First operation to test is just a rollback to the end of any completed phase. This should be possible from a partially successful, errored out or skipped phase.
      1. We need to look at the checkpoint system, cleanup system and watch system to see what they're doing and what we need to update. Let's make sure we hook into utilities and don't rewrite things as we do it.
      2. A rollback should ideally be reversible - if not implemented now then later. A rollback can be a delete or a rollback to resume later. This means we need a system that is branch aware.
3. When we store state, how do we signify when the user rolls back to a phase and starts another one? Do we link the runs together?

<ideas>
