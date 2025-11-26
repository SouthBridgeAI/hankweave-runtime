# Things to rename

1. Tadpole to Strandweave - we are renaming the project to Strandweave Runtime. Tadpole was a good name while in development, but Strandweave fits better and has less learning load. We also have different names eevrywhere like Tadpole, Tadpole Engine, Tadpole Runner, etc - these all become Strandweave Runtime, Strandweave when we want a shorter version.
2. Tadprograms to Strands - this may not affect the code as much (do double check), but the name for the full input package containing prompts, the main json, the workspaces, etc becomes a Strand. Strands in plural. These can be 'reweaved' by AI to combine and change them - this is out of the scope of the code and included for your knowledge.
3. Phases to Codons - this is the most impactful one I think. Phases don't accurately reflect the fact that these units are not just steps in a workflow, but are reusable modules in their own right. Phases and associated things will be renamed to Codons, and:
4. phase config json to codon-sequence.json.
5. workspaces to Rigs - the intent is to prevent confusion between execution directory, project directory and workspaces. Workspaces for Codons or phases are actually more like Rigs, meaning they are carefully crafted and set up to enable the phase to do more work, deterministically.
6. Chroniclers to Sentinels - significantly better name.