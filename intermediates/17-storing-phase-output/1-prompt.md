This is the project we are working on. Check @README.md to indications on how to work with this codebase. background folder contains example phases 
config as well as prompts.

We want to implement the following feature - ability to copy files from tadpole execution directory to `tadpole-results` subdirectory inside users
current working directory. This will allow end users to easily access the results of tadpole work. End users must be able to do the following:

- specify output files that will be copied at the end of the final phase out to the `tadpole-results` subdirectory
- for each phase, specify files (or just copy commands) to copy to a `tadpole-results` directory when successfully completed, and they can accumulate in that folder until the end

These changes will require us to extend the format of the phases.json config as well as add ability to the phase execution engine to copy assets.

Oh Mighty Claude, pleas analyze the requirements above and come up with a detailed implementation plan for this feature. Do ultrathink, as this task
is likely more complex and subtle as it might initially appear. Do provide code snippets with implementation details and indicate where in the codebase
they should go (file name, part of the existing function etc)


Present your findings in `analysis-claude.md` in the same directory where this prompt file is