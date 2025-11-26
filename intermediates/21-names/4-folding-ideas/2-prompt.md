I've given you some of the ideas from the other models. Do these prompt any thoughts or are there some really good ones in there?

Couple more things:
1. We don't want to use Docker terminology directly. We will likely package tadpole inside docker at some point, so directly using it might be problematic.
2. Are there any programming language or orchestration systems that have done this really well?
3. If you forced yourself to completely free ideate, are there any things in the context so far that spark new ideas?

Some things we that we might want the naming to make simple to understand:
1. That there is only one agent loop active at any given time.
2. That phases are sequential - one executes after the other.
3. That chroniclers don't directly mutate the agent loop.
4. That workspaces are actually offloading deterministic work to well designed, reliable programs that the agent can use.
5. That a tadprogram (kind of thing) is something that's meant to ossify over time and be strongly reliable.
6. that tadpole really makes shipping long horizon tasks possible.