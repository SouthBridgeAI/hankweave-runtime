# 1

Okay so this is a project I've made called Strandweave. I'm now figuring out how to separate and implement a config system. I've given you the code and the documentation, and a plan with suggestions.

Now - here's what I know and think:
We need separation at least conceptually between the executing program or strand (which is the codons which is prompts and workspaces etc), and runtime settings. The settings for the runtime can also  split between startup configs and runtime configs, and runtime configs are things you can change while its running. Maybe we call it swRuntimeConfig and codonRunConfig. There are too many ways to set this config, and they all are useful in different ways. Here are some of the use-cases:
1. We want architects of a strand to suggest settings that the strand works best in. Maybe that can split into recommendedsettings and requiredsettings but maybe that's too much.
2. We want local runtime config that's specific to wherever the server is executing in.
3. We want the user or start-er to be able to specify overrides to everything.

Some things I'm not sure about:
1. Do we need so many *methods*? Like do we need console args AND env vars AND config jsons? What is the practice here for simialr things? What is convention?


Can you think through these things and start us off by telling me your broad impressions, pulling out each config and thinking through who would care about it and why at which level, and then going into other programs and runtimes like this and what their convention is?

# 2

Let's think through this a bit more before we write a full spec.

What is the override priority here? Also are we using strandweave.config.json and strandweave.local. json as reserved names that we look for specific places? Is that the convention we're going with?

Why don't we start with *no* defaults at all - is that something we're currenntly doing in the code where we look for a codon config in known places if it's not provided? In this world everything has to explicitly be a superset or define a file to look for configs.

Let's start at a point where the cli needs the following things :
1. data dir (NEEDED and cannot be missed)
2. execution dir (presumed to be ephemeral one if not provided)
3. strand definition - how does this connect to recommended configs?
4. runtimeconfigs for the server - provided as json, cli args or env vars

What do you think? Do you think default reserved filenames and places are better? My worry is that the strandweave runtime is often called from directories that are empty execution directories for it to run in.

# 3

Awesome. Let's write a proper spec covering the motivation and the overall philosophy (I like the function way of putting it), what we're trying to avoid and the behaviors we're tryring to enable, the resolution hierarchy, then more into the specific settings and configs and how they'll work, the schemas and how they'll layer, and finally gotchas or FAQs. Feel free to be very verbose - intent communicated often helps.