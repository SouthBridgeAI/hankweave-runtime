# Writing Reference for Engineering Briefings

These are excerpts from excellent technical writing that capture the tone we want.

---

## Joel Spolsky: Painless Functional Specifications (2000)
https://www.joelonsoftware.com/2000/10/15/painless-functional-specifications-part-4-tips/

### On making specs readable:

> The biggest complaint you'll hear from teams that do write specs is that "nobody reads them." [...] At your typical big, bureaucratic company, everybody spends months and months writing boring specs. Once the spec is done, it goes up on the shelf, never to be taken down again.

### On being specific (Rule 1):

> One of the easiest ways to be funny is to be *specific* when it's not called for. "Scrappy pugs" are funnier than "dogs." "Miss Piggy" is funnier than "the user". Instead of saying "special interests," say "left-handed avocado farmers."

### On writing for humans, not compilers (Rule 2):

> When you write code, your primary audience is the compiler. [...] Which is why, if you think about it, you tend to get programmers who write things like:
>
> "Assume a function AddressOf(x) which is defined as the mapping from a user x, to the RFC-822 compliant email address of that user..."
>
> This could also have been speced as:
>
> "Miss Piggy wants to go to lunch, so she starts a new email and types Kermit's address in the 'To:' box.
> **Technical note:** the address must be a standard Internet address (RFC-822 compliant.)"

### On simplicity (Rule 3):

> Don't use stilted, formal language because you think it's unprofessional to write in simple sentences. Use the simplest language you can.
>
> People use words like "utilize" because they think that "use" looks unprofessional.

### On visual density:

> Avoid walls of text: entire pages with just text. People get scared and don't read them. When was the last time you noticed a popular magazine or newspaper with entire pages of text?

### On templates (Rule 5):

> Avoid the temptation to make a standard template for specs. [...] As these sections accumulate, the template gets pretty large. The trouble with such a large template is that it scares people away from writing specs because it looks like such a daunting task.

---

## Basecamp: Shape Up - Write the Pitch (2019)
https://basecamp.com/shapeup/1.5-chapter-06

### The five ingredients of a pitch:

1. **Problem** — The raw idea, a use case, or something we've seen that motivates us to work on this
2. **Appetite** — How much time we want to spend and how that constrains the solution
3. **Solution** — The core elements we came up with, presented in a form that's easy for people to immediately understand
4. **Rabbit holes** — Details about the solution worth calling out to avoid problems
5. **No-gos** — Anything specifically excluded from the concept

### On always presenting problem with solution:

> Diving straight into "what to build"—the solution—is dangerous. You don't establish any basis for discussing whether this solution is good or bad without a problem.

### On appetite as constraint:

> Stating the appetite and embracing it as a constraint turns everyone into a partner in that process. Anybody can suggest expensive and complicated solutions. It takes work and design insight to get to a simple idea that fits in a small time box.

### On the right level of abstraction:

> We need more concreteness, but we don't want to over-specify the design with wireframes or high-fidelity mocks. They'll box in the designers who do the work later.

---

## Key Principles for Our Briefings

1. **Be specific, not abstract** — Real examples, real file paths, real trade-offs
2. **Problem first** — Why before what
3. **Appetite is a feature** — Constraints focus the conversation
4. **Write simply** — Short sentences, no jargon for jargon's sake
5. **No walls of text** — Break it up, use whitespace
6. **Rabbit holes matter** — Call out the tricky bits explicitly
7. **No-gos are clarifying** — What we're NOT doing is as important as what we are
8. **Write for humans** — Stories and scenarios, not formal definitions
