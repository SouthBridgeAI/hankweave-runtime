# Best parts of the ideas

Name:

* Symbiote (inspired by the oophila symbiotes) - might be too complex for now. We want something that demonstrates clearly the properties we want to engender.
* Familiar: Magic?
* Chronicler: Dune?



Let's go with Chronicler for now.


## Architecture decisions being made

1. Let's use the tadpole server events as the main source stream for the chroniclers. This will enable unit testing, replay, etc.
2. Let's change the websocet log to be a jsonl file that can be used for replay later. We might need to add a wrapper object so we can denote the in/out and timestamps of the packets though.
3. We want Chroniclers to be portable, and to be able to be reused and moved around, so they should be definable in files and be able to be added in to the phases config.
4. Inputs to a Chronicler -
    1. File contents
    2. Event log (toolcalls, assistant messages)
    3. Phase state (costs, tokens used, current state)
5. Triggers to a chronicler
    1. File changes
    2. Content or type of packet in event log with count (e.g. next trigger is when this happens n times)
    3. Phase state thresholds
6. Start conditions (what triggers this chronicler to start operating or listening for triggers?) - could be a combination of
   1. Phase start
   2. Time delay
   3. Or a custom trigger for start after which the trigger for execution runs
7. Chronicler parameters
    1. Debounce
    2. prompts
    3. AI call params (temp, model, output length)
    4. Output format (structured/text - text is wrapped in a json before write)
    5. Input format
        1. Latest-trigger (only the things that triggered the latest)
        2. All (things that triggered the latest and all the previous ones that fit the filter)
    6. Mode
        1. Turn-by-turn (previous message history for chronicler is preserved)
        2. Single-shot (single call, no chat history)
    7. Output filename and location (placed into .tadpole/chronicles)
    8. Name
8. The response type of events from chroniclers so that their results can also be folded into the socket. This might be start, stop, trigger, etc, and also the responses (streaming and not streaming).




## Questions

1. What events happen with the underlying agent that isn't par of the tadpoleserver event stream?
2. How do we define filters and triggers? Will we have to build our own DSL? We want something that appropriately balances simplicity and configurability. Some options are:
    1. Simple JSON-based config in the config file (Simple but might need our own DSL).
    2. Some kind of existing system for doing this like a query language that we can just use.
    3. The chroniclers are proper full typescript files (high configurability) that are loaded in. Somewhat unsafe, hard to enforce good patterns, but you can do whatever you want.
3. We need some kind of watcher that isn't too heavy that can watch the stream, do the filtering and the triggering and start the Chronicler runs appropriately. How do we architect this? What properties do we want out of it?
4. Should we use some kind of db for this? Maybe integrated sqlite? Does it allow for triggers out when things change, or does that need to be implemented through polling?
    1. Here's an example of how it might function through a db:
        1. the tadpole server event logs go into one table - or one per phase.
        2. Each chroniclers filter and trigger are queries into the db.
        3. Each chronicler gets its own output table into the db, as well as a chat history (for ones that want to do turn by turn chat instead of run with a new prompt every time.
        4. The chronicler output table is for each chronicler for each phase its run in. This can be structured data or a wrapped object for pure text.
5. An alternative is to use jsonl files. This might make things simpler and easier, and also allow for the core agent in each phase to make use of the chronicler outputs if it wants to.





## Patterns and concerns (unverified, might change)

- Backpressure: batch windows and max concurrency protect the core process. Watchers must never await inside TadpoleServer.sendEvent; they are entirely decoupled.
- Cancellation: on phase.completed/failed/skipped, watchers should flush and then optionally reset state/history (configurable: scope='phase' | 'run' | 'global').
- Replay: if a watcher state suggests it fell behind (server restart), it can replay .tadpole/events.jsonl until its last offset, then rejoin real-time.
- Idempotency: include event id and timestamp in your watcher outputs; if replaying, dedupe on a compound key.
- Token budget: pre-trim payloads; summarize content server-side if large. Be careful reading files automatically; size caps are mandatory.
- Security: Redactor pipelines run before sending to clients, but you may want default-safe behavior (e.g., drop Bash tool inputs unless explicitly allowed).
- Model/provider abstraction: use AI SDK model string now; later you can inject provider factories. You already pass env vars with TADPOLE_ into Claude; do similarly for watchers if needed.
- Integrating watcher costs into state system





## Transcript pieces

This is from me explaining the system to a coworker.

Core Concept and Purpose

    Origin as a Readability/UI Feature: "The concept here... came out of initially when I was building the thing, it was very useful to have some sort of prompt run on the output of the agentic system itself. The initial thinking I had there was just something that would make it easier for people to read and understand what was actually happening." [3:37]

    Decoupled from the Main Loop: "I'm not actively tied to the agentic loop. So instead of people seeing the full log of what's happening, this was initially meant to be UI work... As things happen on the core agentic Loop, you can give people more information." [4:24]

    It is NOT Parallelizing the Core Agent: "No, no, no, no. Not even a little bit." [8:07] It's clarified that this is not about running multiple core agents in parallel, but rather observing a single core agent.

    The "Note-Taker" Analogy: "It's a lot more like you doing the job... you're sharing your screen, and me and Manu or anyone else is sitting around and just taking notes going like, 'hey, remind Philip later, you know, to do this' or 'Oh, he looked at that. That's actually really interesting.' But we're not interrupting you from your desk." [7:35]

    The "Symbiote" Analogy: "The Gemini suggested symbiotes, because some symbiosis happening. Apparently tadpoles have symbiotes living inside of them from the egg stage that eat the waste products and release oxygen to the egg." [14:28]

The Problem It Solves

    Adding Annotations Without Burdening the Core Agent: "It strikes me as there's a lot of work that you can do in terms of looking at the tool calls themselves and then sort of adding additional annotations instead of that being the primary job of the agentic loop." [5:27]

    Capturing Missing "Upper Level Context": "All of that context is missing... The problems, they're all come from this upper level context not being present when you generate the report." [6:25, 6:35]

    Example of Missing Context: "The final phase or the agent that's generating the report... doesn't actually know that, hey, part of the schema is untested, maybe because we ran out of time, maybe because it wasn't validated." [6:43]

    Offloading Cognitive Load from the Core Agent: "It's too much work for the core agentic loop to interrupt itself... One solution... is to have the agent, the core agent doing it be like, 'oh, every time you find something interesting, go and update this notes file.'" [6:00, 7:11] This new system avoids that.

    Accommodating Different Model Behaviors: "That varies from model to model based on behavior, Right? Sonnet will never do it... GPT5 or something else will get lost doing that instead of doing the actual work. So this is meant to do that." [7:18]

Architectural Properties

    Parallel and Non-Mutating: "It's a parallel system, so it shouldn't complicate the existing code base... Because they don't mutate the core agentic loop, reasoning about race conditions, XYZ becomes significantly easier." [9:26, 15:21]

    Immutability of the Core Loop: "Within that phase we maintain immutability. Like once there's an agentic loop executing inside of a phase, like nobody mutates that." [11:38]

    Non-Critical and Fault-Tolerant: "And none of them are critical. So if they crash, they crash. That's okay. You can work with that." [9:34]

    Event-Driven: "It really only needs to hook into the event stream because the outputs are just going to a file or coming back around to the websocket." [15:26] The source could be the ClaudeLogParser's event stream or the server's main WebSocket output stream. [15:35-15:57]

    Configurable as Data: "All of this has to be definable as data... the same way that phase configs are just a data file... These should also ideally be defined a certain way." [12:53]

    Modular and Reusable: "Each of those ideally can be defined as its own file with the prompt, output schema, input schema, everything else, and maybe a filter that defines when it necessarily gets triggered. And they're reusable, you can copy it over to a different phase and now you have that functionality." [14:43]

Specific Use Cases and Applications

    Human-Readable Summaries & UI Enhancement: "It's really helpful from a UI perspective to give people a better visual or textual understanding of what's happening while something that takes six hours is executing." [11:20]

    Translation: "One of the requests we recently got from one of the customers is like, 'hey, Japanese.' So that in itself could just be another one of these parallel things which is like, 'hey, translate everything Japanese as the agentic lupus running.'" [11:12]

    Data Extraction and Annotation:

        "Keep taking notes on the actual slices of data that are being pulled in versus the size of the data set. So you maintain some level of completion, some level of like a sampling rate." [8:56]

        "Start taking notes on very common command failures that are happening." [9:09]

        "If you see validation scripts, point out if the validation scripts are actually not running on the data... they're just running on a slice." [9:13]

    Monitoring and Evals: "You should be able to define a bunch of these... some of them for monitoring or evals in the future." [15:11]

    Feeding Data to Future Phases: "It can also be really helpful to the agentic loop itself, right? Which might be one of those things where that's data that you can feed back into a future phase as part of the execution." [11:27]

    Structured Event Source Extraction: "Take the agent stream itself and use that as an event source extractor... take what the agent itself is doing, discovering, and then pull it out as structured data, but in a way that's accessible later." [13:38] This is to get maximum efficiency from expensive data reads. [14:04]